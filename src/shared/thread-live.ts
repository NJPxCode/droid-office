// Live daemon state overlaid on the Thread's canonical conversation rows.

/** Factory's droidStatusIndicator states. */
export type ThreadLiveStatus = 'idle' | 'pondering' | 'responding' | 'waiting' | 'compacting';

/** Droid's daemon `DroidWorkingState`. */
export type ThreadLiveWorking = 'idle' | 'thinking' | 'streaming_assistant_message' | 'waiting_for_tool_confirmation' | 'executing_tool' | 'compacting_conversation';

export interface ThreadLiveTool {
  /** The canonical entry (`tool:<tool_use_id>`), when the call is in the conversation file. */
  id?: string;
  name: string;
  startedAt: number;
  phase: 'running' | 'waiting_permission';
  /** A subagent's session running it, when it isn't the worker's own. */
  session?: string;
  /** Execute: streamed output so far. */
  output?: string;
  /** Earlier output lines omitted from the tail. */
  more?: number;
}

export interface ThreadSessionSettings {
  model?: string;
  modelName?: string;
  reasoningEffort?: string;
  interactionMode?: string;
  autonomyLevel?: string;
  autonomyMode?: string;
}

export interface ThreadLiveStream {
  kind: 'thinking' | 'text';
  text: string;
  since: number;
}

export interface ThreadLive {
  rev: number;
  at: number;
  status: ThreadLiveStatus;
  working: ThreadLiveWorking;
  label?: string;
  turnStartedAt?: number;
  phaseSince?: number;
  after?: string;
  stream?: ThreadLiveStream;
  tools: ThreadLiveTool[];
  waiting?: { kind: 'permission' | 'question' | 'spec' | 'other'; toolId?: string };
  settings?: ThreadSessionSettings;
  /** A rewind the office is running in the daemon (worker.rewind), until it ends. */
  rewind?: { entryId: string; since: number };
}

/** Factory's status for a working state (its uEc): an open question or permission wins. */
export function liveStatus(working: ThreadLiveWorking, waiting = false): ThreadLiveStatus {
  if (waiting || working === 'waiting_for_tool_confirmation') return 'waiting';
  if (working === 'streaming_assistant_message') return 'responding';
  if (working === 'compacting_conversation') return 'compacting';
  if (working === 'thinking' || working === 'executing_tool') return 'pondering';
  return 'idle';
}

const EFFORT_LABEL: Record<string, string> = { off: 'Off', none: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

/** Droid's label for a `reasoningEffort` id, e.g. "Extra high" for "xhigh". */
export function effortName(effort: string): string {
  return EFFORT_LABEL[effort.toLowerCase()] ?? effort;
}

/**
 * What `next` adds to `prev`'s live stream when that is all that changed (rev and clock aside): the
 * offset it goes on at and the text, for a `thread.stream` append. Undefined when anything else differs.
 */
export function streamAppend(prev: ThreadLive, next: ThreadLive): { from: number; text: string } | undefined {
  const a = prev.stream;
  const b = next.stream;
  if (!a || !b || a.kind !== b.kind || a.since !== b.since || b.text.length <= a.text.length || !b.text.startsWith(a.text)) return undefined;
  const rest = (live: ThreadLive) => JSON.stringify({ ...live, rev: 0, at: 0, stream: undefined });
  if (rest(prev) !== rest(next)) return undefined;
  return { from: a.text.length, text: b.text.slice(a.text.length) };
}

export function textSignature(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}
