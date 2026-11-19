import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkerAsk, WorkerStatus } from '../shared/protocol.js';
import { liveStatus, outputTail, textSignature, type ThreadLive, type ThreadLiveTool, type ThreadLiveWorking, type ThreadSessionSettings } from '../shared/thread-live.js';
import type { ThreadEntry } from '../shared/worker-thread.js';
import type { ActiveToolCall } from './worker-queue.js';

export interface DaemonLiveToolInput {
  toolUseId: string;
  name: string;
  startedAt: number;
  output?: string;
  more?: number;
  session?: string;
}

export interface DaemonLiveInput {
  working: ThreadLiveWorking;
  stream?: { kind: 'thinking' | 'text'; text: string; since: number; messageId?: string; blockIndex?: number };
  completedThinking?: Record<string, number>;
  tools?: readonly DaemonLiveToolInput[];
  settings?: ThreadSessionSettings;
  label?: string;
}

/** What the server knows of a local worker's turn, gathered by its WorkerManager (see threadLive). */
export interface ThreadLiveInputs {
  sessionId?: string;
  status: WorkerStatus;
  /** When its current working stretch started. */
  workingSince?: number;
  /** Its activity line: compaction can set it. */
  activity?: string;
  ask?: WorkerAsk;
  /** The session raising its needs_input, and the tool it asks about. */
  asking?: { session: string; tool?: string };
  /** Running tool calls by session (PreToolUse to PostToolUse). */
  activeTool: ReadonlyMap<string, ActiveToolCall>;
  /** Live session state pushed directly by droid-daemon notifications. */
  daemon?: DaemonLiveInput;
  /** The office's name for a model id. */
  modelName?(id: string): string | undefined;
  /** A rewind the office is driving on this session. */
  rewind?: { entryId: string; since: number };
}

/** How often a session's settings file is looked at again while it's watched. */
const SETTINGS_RECHECK_MS = 500;
/** Matches the activity label for conversation compaction (worker-runtime/hooks.ts). */
const COMPACTING = /compacting/i;

const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const object = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** A session's `<id>.settings.json`, as Droid 1.12 writes it beside the conversation file. */
export function readSessionSettings(raw: unknown): ThreadSessionSettings {
  const s = object(raw);
  const out: ThreadSessionSettings = {};
  for (const key of ['model', 'reasoningEffort', 'interactionMode', 'autonomyLevel', 'autonomyMode'] as const) {
    const value = str(s[key]);
    if (value) out[key] = value;
  }
  return out;
}

interface SettingsCache {
  file: string;
  checkedAt: number;
  mtimeMs: number;
  value?: ThreadSessionSettings;
}

interface WorkerLive {
  sessionId?: string;
  rev: number;
  digest?: string;
  working: ThreadLiveWorking;
  phaseSince: number;
  /** First seen, by the start of the text it streams. */
  stream?: { key: string; since: number };
  settings?: SettingsCache;
}

export interface ThreadLiveResult {
  live: ThreadLive;
  /** Whether anything but `at` differs from the last one. */
  changed: boolean;
}

/**
 * Keeps each watched worker's `thread.live`: works out the phase, running tools, the message being
 * written and the session's settings from what the office knows now, and bumps `rev` only when that
 * differs from the last one.
 */
export class ThreadLiveTracker {
  private workers = new Map<string, WorkerLive>();

  constructor(private now: () => number = Date.now) {}

  forget(workerId: string): void {
    this.workers.delete(workerId);
  }

  /** `entries` are the conversation's newest canonical rows; `file` its conversation file. */
  async compute(workerId: string, inputs: ThreadLiveInputs, entries: readonly ThreadEntry[], file?: string): Promise<ThreadLiveResult> {
    const now = this.now();
    let state = this.workers.get(workerId);
    if (!state || state.sessionId !== inputs.sessionId) {
      state = { sessionId: inputs.sessionId, rev: state?.rev ?? 0, working: 'idle', phaseSince: now };
      this.workers.set(workerId, state);
    }
    const daemon = inputs.daemon;
    const busy = !inputs.rewind && (inputs.status === 'working' || inputs.status === 'starting' || inputs.status === 'needs_input');
    const waitingFor = busy ? this.waiting(inputs) : undefined;
    let working: ThreadLiveWorking = 'idle';
    if (inputs.rewind) working = 'idle';
    else if (waitingFor) working = 'waiting_for_tool_confirmation';
    else if (busy && inputs.activity && COMPACTING.test(inputs.activity)) working = 'compacting_conversation';
    else if (busy && daemon) working = daemon.working !== 'idle' ? daemon.working : inputs.activeTool.size || daemon.tools?.length ? 'executing_tool' : 'thinking';
    else if (busy && inputs.activeTool.size) working = 'executing_tool';
    else if (busy) working = 'thinking';
    if (working !== state.working) {
      state.working = working;
      state.phaseSince = now;
    }

    const tools = busy ? (daemon ? this.daemonTools(daemon, entries) : this.tools(inputs, entries)) : [];
    let waiting: ThreadLive['waiting'];
    if (waitingFor) {
      const tool = [...entries].reverse().find((e) => e.kind === 'tool' && e.resultSeq === undefined && (!waitingFor.tool || e.name === waitingFor.tool));
      waiting = { kind: waitingFor.kind, ...(tool ? { toolId: tool.id } : {}) };
      for (const t of tools) if (tool && t.id === tool.id) t.phase = 'waiting_permission';
    }

    let stream: ThreadLive['stream'];
    if (busy && daemon?.stream && (working === 'thinking' || working === 'streaming_assistant_message')) {
      const ds = daemon.stream;
      const entryId = ds.messageId ? `${ds.messageId}:${ds.blockIndex ?? 0}` : undefined;
      const landedById = ds.messageId ? entries.some((e) => e.id === `${ds.messageId}:text` || e.id === entryId) : false;
      if (ds.text && !landedById && !landed(ds.text, entries)) {
        const key = `${ds.kind}:${ds.messageId ?? ''}:${ds.blockIndex ?? 0}:${textSignature(ds.text).slice(0, 40)}`;
        if (state.stream?.key !== key) state.stream = { key, since: ds.since || now };
        stream = { kind: ds.kind, text: ds.text, since: state.stream.since, ...(entryId ? { entryId } : {}) };
      }
    }
    if (!stream) state.stream = undefined;

    const filedSettings = daemon?.settings ? undefined : await this.settings(state, file, now);
    const baseSettings = daemon?.settings ?? filedSettings;
    const merged = baseSettings ? { ...baseSettings } : undefined;
    if (merged) {
      const name = merged.model ? inputs.modelName?.(merged.model) : undefined;
      if (name ?? merged.modelName) merged.modelName = name ?? merged.modelName;
    }

    const liveLabel = inputs.rewind ? 'Rewinding conversation...' : working !== 'idle' ? daemon?.label : undefined;
    const body: Omit<ThreadLive, 'rev' | 'at'> = {
      status: inputs.rewind ? 'idle' : liveStatus(working, !!waitingFor),
      working,
      ...(liveLabel ? { label: liveLabel } : {}),
      ...(inputs.rewind ? { rewind: inputs.rewind } : {}),
      ...(busy && inputs.workingSince ? { turnStartedAt: inputs.workingSince } : {}),
      ...(working !== 'idle' ? { phaseSince: state.phaseSince } : {}),
      ...(entries.length ? { after: entries[entries.length - 1].id } : {}),
      ...(stream ? { stream } : {}),
      ...(daemon?.completedThinking ? { completedThinking: daemon.completedThinking } : {}),
      tools,
      ...(waiting ? { waiting } : {}),
      ...(merged ? { settings: merged } : {}),
    };
    const digest = JSON.stringify(body);
    const changed = digest !== state.digest;
    if (changed) {
      state.digest = digest;
      state.rev++;
    }
    return { live: { rev: state.rev, at: now, ...body }, changed };
  }

  private daemonTools(daemon: DaemonLiveInput, entries: readonly ThreadEntry[]): ThreadLiveTool[] {
    let start = entries.length;
    while (start > 0 && !(entries[start - 1].role === 'user' && entries[start - 1].kind === 'text')) start--;
    const open = entries.slice(start).filter((e) => e.kind === 'tool' && e.resultSeq === undefined);
    const byEntryId = new Map<string, DaemonLiveToolInput>();
    for (const dt of daemon.tools ?? []) {
      if (!dt.session) byEntryId.set(`tool:${dt.toolUseId}`, dt);
    }
    const out: ThreadLiveTool[] = [];
    const seenIds = new Set<string>();
    for (const entry of open) {
      seenIds.add(entry.id);
      const dt = byEntryId.get(entry.id);
      const tool: ThreadLiveTool = {
        id: entry.id,
        name: entry.name ?? dt?.name ?? 'Tool',
        startedAt: dt?.startedAt ?? entry.at ?? this.now(),
        phase: 'running',
      };
      if (dt?.output !== undefined) Object.assign(tool, outputTail(dt.output, dt.more));
      out.push(tool);
    }
    for (const dt of daemon.tools ?? []) {
      const entryId = `tool:${dt.toolUseId}`;
      if (!dt.session && seenIds.has(entryId)) continue;
      // Tools that already closed in the canonical transcript are skipped even if tool_result arrives slightly after file flush.
      if (!dt.session && entries.some((e) => e.id === entryId && e.resultSeq !== undefined)) continue;
      const tool: ThreadLiveTool = {
        name: dt.name || 'Tool',
        startedAt: dt.startedAt,
        phase: 'running',
        ...(dt.session ? { session: dt.session } : {}),
      };
      if (dt.output !== undefined) Object.assign(tool, outputTail(dt.output, dt.more));
      out.push(tool);
    }
    return out;
  }

  private waiting(inputs: ThreadLiveInputs): { kind: NonNullable<ThreadLive['waiting']>['kind']; tool?: string } | undefined {
    if (inputs.status !== 'needs_input') return undefined;
    const ask = inputs.ask;
    if (ask?.kind === 'question') return { kind: 'question', tool: 'AskUser' };
    const tool = ask?.tool ?? inputs.asking?.tool;
    if (tool === 'ExitSpecMode') return { kind: 'spec', tool };
    if (ask?.kind === 'permission') return { kind: 'permission', tool };
    return { kind: 'other', ...(tool ? { tool } : {}) };
  }

  /** The turn's calls still without a result, and the subagents' running ones. */
  private tools(inputs: ThreadLiveInputs, entries: readonly ThreadEntry[]): ThreadLiveTool[] {
    let start = entries.length;
    while (start > 0 && !(entries[start - 1].role === 'user' && entries[start - 1].kind === 'text')) start--;
    const open = entries.slice(start).filter((e) => e.kind === 'tool' && e.resultSeq === undefined);
    const out: ThreadLiveTool[] = [];
    const claimed = new Set<ActiveToolCall>();
    const own = inputs.sessionId;
    for (const entry of open) {
      const call = own ? inputs.activeTool.get(own) : undefined;
      const mine = call && !claimed.has(call) && call.tool === entry.name;
      if (mine) claimed.add(call);
      out.push({ id: entry.id, name: entry.name ?? 'Tool', startedAt: mine ? call.startedAt : (entry.at ?? this.now()), phase: 'running' });
    }
    for (const [session, call] of inputs.activeTool) {
      if (claimed.has(call) || session === own) continue;
      out.push({ name: call.tool, startedAt: call.startedAt, phase: 'running', session });
    }
    return out;
  }

  private async settings(state: WorkerLive, file: string | undefined, now: number): Promise<ThreadSessionSettings | undefined> {
    if (!file || !state.sessionId) return undefined;
    const target = path.join(path.dirname(file), `${state.sessionId}.settings.json`);
    const cache = state.settings?.file === target ? state.settings : (state.settings = { file: target, checkedAt: 0, mtimeMs: -1 });
    if (now - cache.checkedAt < SETTINGS_RECHECK_MS) return cache.value;
    cache.checkedAt = now;
    const info = await stat(target).catch(() => undefined);
    if (!info) return cache.value;
    if (info.mtimeMs === cache.mtimeMs) return cache.value;
    try {
      cache.value = readSessionSettings(JSON.parse(await readFile(target, 'utf8')));
      cache.mtimeMs = info.mtimeMs;
    } catch {
      // Droid rewrites the file in place: a half-written one is read again next time.
    }
    return cache.value;
  }
}

/** Whether a message from the daemon stream is already in the conversation file. */
function landed(text: string, entries: readonly ThreadEntry[]): boolean {
  const shown = textSignature(text);
  if (!shown) return true;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.role === 'user' && entry.kind === 'text') break;
    if (entry.role !== 'assistant' || (entry.kind !== 'text' && entry.kind !== 'thinking') || !entry.text) continue;
    if (textSignature(entry.text).includes(shown)) return true;
  }
  return false;
}
