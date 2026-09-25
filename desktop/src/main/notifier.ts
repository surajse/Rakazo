import { Notification } from 'electron'
import { getApprovals } from './api'
import { loadToken } from './store'
import { focusQuickChatWithBot } from './windows'

const POLL_MS = 30_000
const seen = new Set<string>()
let timer: NodeJS.Timeout | null = null

function notifyApproval(a: { id: string; bot_id: string; bot_name?: string; title?: string; kind?: string; description?: string }): void {
  const n = new Notification({
    title: `Approval needed — ${a.bot_name ?? 'your bot'}`,
    body: a.description ?? a.title ?? a.kind ?? 'A bot is waiting for your approval.',
    silent: false
  })
  // Clicking opens the relevant bot's quick chat.
  n.on('click', () => focusQuickChatWithBot(a.bot_id))
  n.show()
}

export function notifyRunFinished(botName: string): void {
  const n = new Notification({
    title: `${botName} finished`,
    body: 'Your bot completed its run. Click to review.',
    silent: false
  })
  n.show()
}

async function poll(): Promise<void> {
  if (!loadToken()) return
  let approvals
  try {
    approvals = await getApprovals()
  } catch {
    return // backend down / token expired — stay quiet, setup screen explains
  }
  for (const a of approvals) {
    if (seen.has(a.id)) continue
    seen.add(a.id)
    notifyApproval(a)
  }
}

export function startApprovalPolling(): void {
  stopApprovalPolling()
  timer = setInterval(() => void poll(), POLL_MS)
  void poll()
}

export function stopApprovalPolling(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export async function pollApprovalsNow(): Promise<void> {
  await poll()
}
