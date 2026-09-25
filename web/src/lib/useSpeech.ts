import { useCallback, useEffect, useRef, useState } from 'react';

/*
 * Reusable browser speech logic for voice mode. Everything here uses the
 * built-in Web Speech APIs — no API keys or network calls involved.
 *
 * - useDictation: mic button → SpeechRecognition dictation into a text input.
 * - useSpeechOutput: speaker toggles → speechSynthesis reads text aloud.
 */

/* --------------------------- support detection --------------------------- */

export function isSpeechRecognitionSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as Record<string, unknown>;
  return typeof w.SpeechRecognition === 'function' || typeof w.webkitSpeechRecognition === 'function';
}

export function isSpeechSynthesisSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return 'speechSynthesis' in window && typeof window.speechSynthesis?.speak === 'function';
}

/* ---------------------- minimal Web Speech API typings --------------------- */

interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

/* -------------------------------- dictation -------------------------------- */

export interface DictationOptions {
  /** BCP-47 language tag, defaults to the browser locale. */
  lang?: string;
  /** Called with each finalized transcript chunk. */
  onFinal?: (text: string) => void;
}

export function useDictation({ lang, onFinal }: DictationOptions = {}) {
  const [supported] = useState(isSpeechRecognitionSupported);
  const [listening, setListening] = useState(false);
  /** Latest in-progress (non-final) words, for live feedback. */
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const stop = useCallback(() => {
    try {
      recRef.current?.stop();
    } catch {
      // stop() can throw if recognition never started; onend resets state anyway.
    }
  }, []);

  const start = useCallback(() => {
    if (!isSpeechRecognitionSupported()) return;
    setError(null);
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      setError('Voice input is not supported in this browser.');
      return;
    }
    try {
      recRef.current?.abort();
      const rec = new Ctor();
      recRef.current = rec;
      rec.lang = lang ?? navigator.language ?? 'en-US';
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.onresult = (ev) => {
        let finals = '';
        let interims = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const result = ev.results[i];
          const transcript = result[0]?.transcript ?? '';
          if (result.isFinal) {
            finals += transcript;
          } else {
            interims += transcript;
          }
        }
        setInterim(interims.trim());
        const text = finals.trim();
        if (text) {
          setInterim('');
          onFinalRef.current?.(text);
        }
      };
      rec.onerror = (ev) => {
        if (ev?.error === 'aborted') return;
        setError(
          ev?.error === 'not-allowed'
            ? 'Microphone access was blocked. Allow it in your browser settings to use dictation.'
            : `Dictation error: ${ev?.error ?? 'unknown'}.`,
        );
        setListening(false);
        setInterim('');
      };
      rec.onend = () => {
        setListening(false);
        setInterim('');
      };
      rec.start();
      setListening(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start dictation.');
      setListening(false);
    }
  }, [lang]);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  useEffect(() => {
    return () => {
      try {
        recRef.current?.abort();
      } catch {
        // ignore teardown errors
      }
    };
  }, []);

  return {
    supported,
    listening,
    interim,
    error,
    start,
    stop,
    toggle,
    clearError: () => setError(null),
  };
}

/* ------------------------------ speech output ------------------------------ */

/**
 * Strip Markdown formatting so bot replies sound natural when read aloud.
 */
export function stripMarkdownForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → link text
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/^\s*[-*+]\s+/gm, '') // bullet lists
    .replace(/^\s*\d+\.\s+/gm, '') // numbered lists
    .replace(/^>\s?/gm, '') // blockquotes
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1') // emphasis
    .replace(/\n{2,}/g, '. ') // paragraph breaks
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function useSpeechOutput() {
  const [supported] = useState(isSpeechSynthesisSupported);
  /** id of the message currently being read aloud, or null. */
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  const stop = useCallback(() => {
    if (isSpeechSynthesisSupported()) {
      window.speechSynthesis.cancel();
    }
    setSpeakingId(null);
  }, []);

  const speak = useCallback(
    (id: string, text: string) => {
      if (!isSpeechSynthesisSupported()) return;
      const synth = window.speechSynthesis;
      // Cancel any current utterance first — only one speaks at a time.
      synth.cancel();
      setSpeakingId(null);
      const clean = stripMarkdownForSpeech(text);
      if (!clean) return;
      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.lang = navigator.language ?? 'en-US';
      utterance.onend = () => setSpeakingId(null);
      utterance.onerror = () => setSpeakingId(null);
      setSpeakingId(id);
      synth.speak(utterance);
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (isSpeechSynthesisSupported()) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  return { supported, speakingId, speak, stop };
}
