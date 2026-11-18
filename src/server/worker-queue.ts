import type { QueuedMessageDelivery, QueuedMessageItem, QueuedMessageSource, WorkerQueueState, WorkerStatus } from '../shared/protocol.js';

export type { QueuedMessageDelivery, QueuedMessageItem, QueuedMessageSource, WorkerQueueState };

export interface DaemonQueuedEntry {
  requestId: string;
  text: string;
  queuePlacement: 'end_of_turn' | 'end_of_loop';
  hasImage?: boolean;
}

export function parseDaemonQueueList(raw: unknown): DaemonQueuedEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: DaemonQueuedEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    const requestId = typeof r.requestId === 'string' && r.requestId ? r.requestId : typeof r.id === 'string' && r.id ? r.id : '';
    if (!requestId) continue;
    const text = typeof r.text === 'string' ? r.text : '';
    const queuePlacement = r.queuePlacement === 'end_of_loop' ? 'end_of_loop' : 'end_of_turn';
    const hasImage = (typeof r.imageCount === 'number' && r.imageCount > 0) || (Array.isArray(r.images) && r.images.length > 0) || (Array.isArray(r.imagePaths) && r.imagePaths.length > 0);
    out.push({ requestId, text, queuePlacement, ...(hasImage ? { hasImage: true } : {}) });
  }
  return out;
}

export function buildDaemonQueueState(entries: readonly DaemonQueuedEntry[], held: readonly string[] = []): WorkerQueueState {
  const items: QueuedMessageItem[] = [];
  for (const text of held) {
    items.push({
      index: items.length + 1,
      text,
      preview: false,
      moreLines: 0,
      source: 'outbox',
      delivery: 'next_step',
    });
  }
  const steering = entries.filter((e) => e.queuePlacement === 'end_of_turn');
  const afterTurn = entries.filter((e) => e.queuePlacement === 'end_of_loop');
  for (const entry of [...steering, ...afterTurn]) {
    items.push({
      id: entry.requestId,
      index: items.length + 1,
      text: entry.text,
      ...(entry.hasImage ? { hasImage: true } : {}),
      preview: false,
      moreLines: 0,
      source: 'droid',
      delivery: entry.queuePlacement === 'end_of_loop' ? 'after_turn' : 'steering',
    });
  }
  return { count: items.length, items, moreSteering: 0, moreQueued: 0 };
}

export interface BlockingToolState {
  tool: string;
  command?: string;
  runningForMs: number;
  reason: 'watch_command' | 'long_running';
}

export interface ActiveToolCall {
  tool: string;
  input: unknown;
  startedAt: number;
}

/** Running tool calls at or past this threshold are surfaced as blocking steers. */
export const BLOCKING_TOOL_MS = 15_000;

/** Known watch/follow/sleep shell commands that block tool completion until interrupted or finished. */
const WATCH_COMMAND_RE =
  /\bgh\s+(?:run\s+watch\b|pr\s+checks\b[^\n;|&]*--watch\b)|\bglab\s+ci\s+(?:status|trace)\b[^\n;|&]*--(?:wait|live)\b|\bkubectl\s+(?:wait\b|logs\b[^\n;|&]*-f\b|rollout\s+status\b)|\bdocker\s+(?:compose\s+)?logs\b[^\n;|&]*-f\b|\btail\s+(?:-[^\n;|&]*f\b|--follow\b)|(?:^|[;&|]\s*)watch\s+\S|(?:^|[;&|]\s*)sleep\s+(?:[5-9]|\d{2,})(?:\.\d+)?\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|watch)\b/;

function clipOneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function extractToolCommand(tool: string, input: unknown): string | undefined {
  if (tool !== 'Execute' && tool !== 'Bash') return undefined;
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const raw = typeof obj.command === 'string' ? obj.command : typeof obj.cmd === 'string' ? obj.cmd : undefined;
  if (!raw?.trim()) return undefined;
  return clipOneLine(raw, 120);
}

function isWatchCommand(command: string | undefined): boolean {
  return !!command && WATCH_COMMAND_RE.test(command);
}

/**
 * Returns the worker's active blocking tool call when it is mid-turn inside a known watch command
 * (such as `gh run watch`) or a tool call that has run for at least BLOCKING_TOOL_MS.
 */
export function detectBlockingTool(status: WorkerStatus, activeTools: ReadonlyMap<string, ActiveToolCall>, now = Date.now()): BlockingToolState | undefined {
  if (status !== 'working' || !activeTools.size) return undefined;
  let picked: BlockingToolState | undefined;
  for (const call of activeTools.values()) {
    const runningForMs = Math.max(0, now - call.startedAt);
    const command = extractToolCommand(call.tool, call.input);
    const watch = (call.tool === 'Execute' || call.tool === 'Bash') && isWatchCommand(command);
    if (!watch && runningForMs < BLOCKING_TOOL_MS) continue;
    const candidate: BlockingToolState = {
      tool: call.tool,
      ...(command ? { command } : {}),
      runningForMs,
      reason: watch ? 'watch_command' : 'long_running',
    };
    if (!picked || (candidate.reason === 'watch_command' && picked.reason !== 'watch_command') || candidate.runningForMs > picked.runningForMs) {
      picked = candidate;
    }
  }
  return picked;
}

function formatDurationShort(ms: number): string {
  const secs = Math.max(1, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem ? `${mins}m ${rem}s` : `${mins}m`;
}

export function formatBlockingSummary(b: BlockingToolState): string {
  const what = b.command ? `${b.tool}: \`${b.command}\`` : b.tool;
  return `${what} (${formatDurationShort(b.runningForMs)})`;
}

export function formatBlockingSteerWarning(name: string, b: BlockingToolState): string {
  return `${name} is inside a blocking command (${formatBlockingSummary(b)}) — steers wait until this tool call finishes. Pass urgent: true (or call office_worker_interrupt) to interrupt it now.`;
}

export function formatQueueBrief(queue: WorkerQueueState): string | undefined {
  if (!queue.count) return undefined;
  const previews = queue.items.slice(0, 3).map((item) => {
    const tag = item.delivery === 'after_turn' ? 'after turn' : item.delivery === 'steering' ? 'steering' : 'next step';
    return `#${item.index} [${tag}] "${clipOneLine(item.text, 60)}"`;
  });
  const extra = queue.count - previews.length;
  return `Queued (${queue.count}): ${previews.join('; ')}${extra > 0 ? ` (+${extra} more)` : ''}`;
}
