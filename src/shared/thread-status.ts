import type { WorkerStatus } from './protocol.js';
import type { ThreadEntry } from './worker-thread.js';

interface StatusTool {
  id?: string;
  name: string;
  startedAt: number;
  phase: string;
}

interface StatusLive {
  status: string;
  working: string;
  label?: string;
  phaseSince?: number;
  turnStartedAt?: number;
  skew: number;
  tools: readonly StatusTool[];
  waiting?: { kind: string };
}

export interface ThreadStatus {
  label: string;
  detail?: string;
  /** Start of the current phase, in the client's clock. */
  since?: number;
  waiting?: boolean;
}

function toolTitle(tool: StatusTool, entries: readonly ThreadEntry[]): string {
  if (tool.id && tool.name.split(/[.:]/).at(-1)?.toLowerCase() === 'execute') {
    const input = entries.find((entry) => entry.id === tool.id && entry.kind === 'tool')?.input;
    if (input) {
      try {
        const command: unknown = JSON.parse(input)?.command;
        if (typeof command === 'string' && command.trim()) return command.trim().replace(/\s+/g, ' ');
      } catch {
        // A clipped or not-yet-recorded call still has its tool name.
      }
    }
  }
  return tool.name;
}

/** Derive the status from current daemon work, not from the last recorded reply. */
export function threadStatus(worker: { status: WorkerStatus; workingSince?: number; ask?: unknown; menu?: unknown }, live: StatusLive | undefined, entries: readonly ThreadEntry[], detail?: string): ThreadStatus | undefined {
  if (worker.status === 'starting') return { label: 'Starting worker…' };
  if (worker.status !== 'working' && worker.status !== 'needs_input') return undefined;
  const since = (at: number | undefined) => (at === undefined ? undefined : at + (live?.skew ?? 0));
  if (worker.status === 'needs_input' || live?.status === 'waiting') {
    const kind = live?.waiting?.kind ?? (live?.working === 'waiting_for_tool_confirmation' ? 'permission' : worker.ask || worker.menu ? 'question' : undefined);
    const reason = kind === 'permission' ? ': permission needed' : kind === 'question' ? ': answer needed' : kind === 'spec' ? ': review needed' : '';
    return { label: `Waiting for you${reason}`, waiting: true };
  }
  const phaseSince = since(live?.phaseSince ?? live?.turnStartedAt) ?? since(worker.workingSince);
  if (live?.status === 'compacting') return { label: 'Compacting conversation…', since: phaseSince, detail: live.label };
  // Writing and thinking can overlap with a subagent's tool. Report the active tool when present.
  const tool = live?.tools
    .slice()
    .reverse()
    .find((call) => call.phase === 'running');
  if (tool) return { label: `Running: ${toolTitle(tool, entries)}`, since: since(tool.startedAt), detail: live?.label };
  if (live?.status === 'responding') return { label: 'Writing', since: phaseSince, detail: live.label };
  if (live?.working === 'thinking') return { label: 'Thinking', since: phaseSince, detail: live.label };
  return { label: 'Working…', since: phaseSince, detail: live?.label || detail || undefined };
}

export function statusElapsed(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** "12s": whole seconds, at least 1, as Factory's thinking block counts them. */
export function thinkingSeconds(ms: number): string {
  return `${Math.max(1, Math.floor(ms / 1000))}s`;
}

/** "Thought for 25s", or "Thought" when the time isn't known. */
export function thoughtLabel(ms: number | undefined): string {
  return ms !== undefined && Number.isFinite(ms) && ms >= 0 ? `Thought for ${thinkingSeconds(ms)}` : 'Thought';
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];
let narrow: Intl.RelativeTimeFormat | undefined;

/** "22h ago", "5m ago", "now": Factory's narrow relative time under a message, at minute resolution. */
export function relativeTime(at: number, now: number): string {
  narrow ??= new Intl.RelativeTimeFormat('en', { style: 'narrow', numeric: 'always' });
  const delta = at - now;
  for (const [unit, size] of UNITS) if (Math.abs(delta) >= size) return narrow.format(Math.trunc(delta / size), unit);
  return 'now';
}
