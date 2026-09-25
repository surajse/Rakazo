export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export const TEMPLATE_FALLBACKS = [
  { id: 'inbox_manager', name: 'Inbox Manager', description: 'Triages email, drafts replies, flags what needs you.' },
  { id: 'sales_outbound', name: 'Sales Outbound', description: 'Researches leads and drafts personalized outreach.' },
  { id: 'talent_scout', name: 'Talent Scout', description: 'Screens candidates and summarizes the standouts.' },
  { id: 'expense_manager', name: 'Expense Manager', description: 'Categorizes receipts and keeps spend in line.' },
  { id: 'bug_triage', name: 'Bug Triage', description: 'Reads new issues, reproduces, and proposes fixes.' },
  { id: 'account_manager', name: 'Account Manager', description: 'Keeps track of key accounts and follow-ups.' },
  { id: 'paid_media', name: 'Paid Media', description: 'Monitors campaigns and suggests budget moves.' },
  { id: 'chief_of_staff', name: 'Chief of Staff', description: 'Turns scattered notes into a clear plan of action.' },
];

export const MODEL_PRESETS = [
  { id: 'openai', name: 'OpenAI', kind: 'openai_compatible', base_url: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', base_url: 'https://api.anthropic.com', model: 'claude-sonnet-4-5-20250929' },
  { id: 'ollama', name: 'Ollama (local)', kind: 'ollama', base_url: 'http://localhost:11434', model: 'llama3.1' },
  { id: 'groq', name: 'Groq', kind: 'openai_compatible', base_url: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai_compatible', base_url: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4' },
] as const;
