import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { api, ApiError } from '@/api/client';
import type { Bot, ChatMessage } from '@/api/types';
import { BotSettingsSheet } from '@/components/BotSettingsSheet';
import { Composer } from '@/components/Composer';
import { EmptyState } from '@/components/EmptyState';
import { MessageBubble, type UiMessage } from '@/components/MessageBubble';
import { Screen } from '@/components/Screen';
import { useApprovals } from '@/store/approvals';
import { colors, fontSize, spacing } from '@/theme';

const PAGE_LIMIT = 30;
const TOKEN_FLUSH_MS = 60;

function toUi(message: ChatMessage): UiMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.created_at,
    toolCalls: message.tool_calls,
  };
}

export default function BotChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { refresh: refreshApprovals } = useApprovals();

  const [bot, setBot] = useState<Bot | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]); // newest first (inverted list)
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const activeRunId = useRef<string | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadBot = useCallback(async () => {
    try {
      setBot(await api.getBot(id));
    } catch {
      // keep previous bot info on transient errors
    }
  }, [id]);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const [freshBot, page] = await Promise.all([api.getBot(id), api.listMessages(id, undefined, PAGE_LIMIT)]);
      setBot(freshBot);
      setMessages(page.messages.map(toUi));
      setHasMore(page.next_before != null || page.messages.length >= PAGE_LIMIT);
    } catch {
      // error UI handled below via empty state
    } finally {
      setLoading(false);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void loadInitial();
    }, [loadInitial]),
  );

  // Abort any in-flight stream when leaving the screen.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (flushTimer.current) clearTimeout(flushTimer.current);
    },
    [],
  );

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || messages.length === 0) return;
    setLoadingMore(true);
    try {
      const oldest = messages[messages.length - 1];
      const page = await api.listMessages(id, oldest.id, PAGE_LIMIT);
      if (page.messages.length > 0) {
        setMessages((prev) => [...prev, ...page.messages.map(toUi)]);
      }
      setHasMore(page.next_before != null && page.messages.length >= PAGE_LIMIT);
    } catch {
      // keep list as-is
    } finally {
      setLoadingMore(false);
    }
  }, [id, loadingMore, hasMore, messages]);

  const stopStream = useCallback(async () => {
    abortRef.current?.abort();
    const runId = activeRunId.current;
    activeRunId.current = null;
    if (runId) {
      try {
        await api.cancelRun(id, runId);
      } catch {
        // stream already aborted; backend cancel is best-effort
      }
    }
  }, [id]);

  const runStream = useCallback(
    async (runId: string) => {
      const streamId = `stream-${runId}`;
      setMessages((prev) => [
        {
          id: streamId,
          role: 'assistant',
          content: '',
          createdAt: new Date().toISOString(),
          streaming: true,
          toolCalls: [],
        },
        ...prev,
      ]);
      setStreaming(true);
      activeRunId.current = runId;
      const controller = new AbortController();
      abortRef.current = controller;

      // Batch token appends so the list doesn't re-render per token.
      let pendingText = '';
      const flush = () => {
        if (!pendingText) return;
        const chunk = pendingText;
        pendingText = '';
        setMessages((prev) =>
          prev.map((m) => (m.id === streamId ? { ...m, content: m.content + chunk } : m)),
        );
      };
      const scheduleFlush = () => {
        if (!flushTimer.current) {
          flushTimer.current = setTimeout(() => {
            flushTimer.current = null;
            flush();
          }, TOKEN_FLUSH_MS);
        }
      };
      const patchStream = (patch: Partial<UiMessage>) =>
        setMessages((prev) => prev.map((m) => (m.id === streamId ? { ...m, ...patch } : m)));
      const patchToolCall = (toolId: string, patch: { output?: unknown; status?: 'running' | 'done' | 'error' }) =>
        setMessages((prev) =>
          prev.map((m) =>
            m.id === streamId
              ? {
                  ...m,
                  toolCalls: (m.toolCalls ?? []).map((tc) => (tc.id === toolId ? { ...tc, ...patch } : tc)),
                }
              : m,
          ),
        );

      try {
        await api.streamRun({
          botId: id,
          runId,
          signal: controller.signal,
          onEvent: (event) => {
            switch (event.type) {
              case 'token':
                pendingText += event.text;
                scheduleFlush();
                break;
              case 'tool_call':
                flush();
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === streamId
                      ? {
                          ...m,
                          toolCalls: [
                            ...(m.toolCalls ?? []),
                            { id: event.id, name: event.name, input: event.input, status: 'running' as const },
                          ],
                        }
                      : m,
                  ),
                );
                break;
              case 'tool_result':
                patchToolCall(event.id, { output: event.output, status: 'done' });
                break;
              case 'approval_request':
                flush();
                setMessages((prev) => [
                  {
                    id: `approval-${event.id}-${Date.now()}`,
                    role: 'system',
                    content: `Approval requested: ${event.description}`,
                    createdAt: new Date().toISOString(),
                  },
                  ...prev,
                ]);
                void refreshApprovals();
                break;
              case 'done':
                flush();
                // Prefer the finalized message when the backend sends one,
                // but never clobber streamed tokens with an empty payload.
                if (event.message?.content) {
                  patchStream({ streaming: false, content: event.message.content });
                } else {
                  patchStream({ streaming: false });
                }
                if (event.message?.tool_calls) patchStream({ toolCalls: event.message.tool_calls });
                void loadBot();
                break;
              case 'error':
                flush();
                patchStream({ streaming: false, error: event.message });
                void loadBot();
                break;
            }
          },
        });
        flush();
      } catch (e) {
        flush();
        if (controller.signal.aborted) {
          patchStream({ streaming: false });
        } else {
          patchStream({
            streaming: false,
            error: e instanceof ApiError ? e.message : 'Stream interrupted. Pull to refresh to see the latest.',
          });
        }
        void loadBot();
      } finally {
        if (flushTimer.current) {
          clearTimeout(flushTimer.current);
          flushTimer.current = null;
        }
        setStreaming(false);
        abortRef.current = null;
        activeRunId.current = null;
      }
    },
    [id, loadBot, refreshApprovals],
  );

  const send = useCallback(
    async (text: string) => {
      const tempId = `tmp-${Date.now()}`;
      setMessages((prev) => [
        { id: tempId, role: 'user', content: text, createdAt: new Date().toISOString() },
        ...prev,
      ]);
      try {
        const { run_id, message } = await api.postMessage(id, text);
        setMessages((prev) => prev.map((m) => (m.id === tempId ? toUi(message) : m)));
        await runStream(run_id);
      } catch (e) {
        // Drop the optimistic message and surface the failure inline.
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        setMessages((prev) => [
          {
            id: `err-${Date.now()}`,
            role: 'system',
            content: e instanceof Error ? e.message : 'Failed to send message',
            createdAt: new Date().toISOString(),
          },
          ...prev,
        ]);
      }
    },
    [id, runStream],
  );

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: bot?.name ?? 'Chat',
          headerRight: () => (
            <TouchableOpacity onPress={() => setSettingsOpen(true)} hitSlop={12}>
              <Text style={styles.headerAction}>Settings</Text>
            </TouchableOpacity>
          ),
        }}
      />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : messages.length === 0 ? (
        <View style={styles.flex}>
          <EmptyState
            title={`Say hi to ${bot?.name ?? 'your bot'}`}
            body="One ongoing thread. Everything it does here is remembered."
          />
        </View>
      ) : (
        <FlatList
          style={styles.flex}
          inverted
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => <MessageBubble message={item} />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? <ActivityIndicator size="small" color={colors.primary} style={styles.more} /> : null
          }
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
        />
      )}
      <Composer streaming={streaming} onSend={(t) => void send(t)} onStop={() => void stopStream()} />
      <BotSettingsSheet
        botId={settingsOpen ? id : null}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => void loadBot()}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { paddingVertical: spacing.sm },
  more: { marginVertical: spacing.sm },
  headerAction: { color: colors.primary, fontSize: fontSize.md, fontWeight: '600' },
});
