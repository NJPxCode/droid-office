import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { isAgentEffort, type WorkerInfo, type WorkerStatus } from '../../shared/protocol.js';
import { inputQuestions, permissionLine } from '../../shared/ask-question.js';
import { toolRefresh, type ToolRefresh } from '../hook-refresh.js';
import { FAILS_TO_DESPAIR, outputFailed, toolAction } from '../../shared/actions.js';
import { officeSays, withoutReminders } from '../../shared/prompts.js';
import { readDroidQueue } from '../../shared/droid-queue.js';
import { todoItems, todoProgress } from '../../shared/todos.js';
import { searchKey, snippet } from '../../shared/search.js';
import type { ThreadLiveWorking, ThreadSessionSettings } from '../../shared/thread-live.js';
import { record } from '../factory/cloud-stream-messages.js';
import { buildDaemonQueueState, parseDaemonQueueList } from '../worker-queue.js';
import { readDroidScreen } from '../droid-screen.js';
import { screenRows, type Worker } from './state.js';
import { HOOK_EVENTS, HOOK_VERSION } from './hook-transport.js';
import { describeTool, permissionAsk, truncate } from './activity.js';
import type { WorkerDelivery } from './delivery.js';

interface HookContext {
  get(id: string): Worker | undefined;
  closing(): boolean;
  persist(): void;
  update(worker: Worker): void;
  setStatus(worker: Worker, status: WorkerStatus): void;
  setup(worker: Worker, report: Record<string, unknown>): boolean;
  refreshModel(worker: Worker): void;
  syncBranch(worker: Worker): Promise<void>;
  tool(workerId: string, refresh: ToolRefresh): void;
  notePrompt(worker: Worker, text: string): void;
  beforeStop(info: WorkerInfo): string | undefined;
  nextTurn(info: WorkerInfo): void;
  delivery: Pick<WorkerDelivery, 'sendLaunchPrompt'>;
}

/**
 * How long a Stop waits for another hook before the turn is done: a Stop hook that blocks shows up
 * as a new tool call or a second Stop well within it.
 */
export const STOP_GRACE_MS = 1200;
/** How long after Escape or Ctrl+C a Stop counts as the turn being cancelled (see stopped). */
const CANCEL_MS = 3000;
/** A worker's activity while Droid compacts its conversation (PreCompact, until the compact SessionStart). */
const COMPACTING = 'Compacting its conversation';
/** Tools that ask the person a question: droid's is AskUser. */
const ASK_TOOLS = new Set<unknown>(['AskUser', 'AskUserQuestion', 'request_user_input']);

/** Applies authenticated session/subagent hooks and owns the delayed Stop lifecycle. */
export class WorkerHooks {
  constructor(private context: HookContext) {}

  /** A hook from the worker's droid, live (`version`) or replayed from its spool (`at`, when it fired). */
  accept(w: Worker, event: string, payload: unknown, from: { version: number } | { at: number }): string | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const report = payload as Record<string, unknown>;
    if (report.hook_event_name !== event) return undefined;
    if (event === 'WorktreeSetup') return this.context.setup(w, report) ? '' : undefined;
    if (w.info.kind !== 'agent' || typeof report.session_id !== 'string' || !report.session_id) return undefined;
    if (!HOOK_EVENTS.includes(event)) return undefined;
    const session = report.session_id;
    const caller = typeof report.calling_session_id === 'string' && report.calling_session_id ? report.calling_session_id : undefined;
    if (event === 'SessionStart' && caller) {
      // A subagent its droid just started (the Task tool): a session of its own, inside this one's turn.
      w.info.sessionId ??= caller;
      if (caller !== w.info.sessionId && !w.subSessions.has(caller)) return undefined;
      w.subSessions.add(session);
    }
    const sub = w.subSessions.has(session);
    if (!sub && event !== 'SessionStart' && w.info.sessionId && session !== w.info.sessionId) return undefined;
    const live = 'version' in from;
    if (live) w.hookVersion = from.version;
    w.hookAt = live ? Date.now() : from.at;
    // Any hook after a Stop means the turn went on: a Stop starts the grace again (see stopped).
    w.stopAt = undefined;
    const reply = sub ? this.subagentHook(w, event, report, live) : this.sessionHook(w, event, report, live && w.hookVersion >= HOOK_VERSION);
    this.context.update(w);
    this.context.persist();
    return reply ?? '';
  }

  /**
   * A hook from the worker's own session. With `replies` (a live hook from a command that prints
   * what the office answers), PostToolUse and Stop can carry its notices; the reply is returned.
   */
  private sessionHook(w: Worker, event: string, report: Record<string, unknown>, replies: boolean): string | undefined {
    const session = report.session_id as string;
    const transcript = report.transcript_path;
    if (typeof transcript === 'string' && path.isAbsolute(transcript) && path.basename(transcript) === `${session}.jsonl`) w.transcript = transcript;
    let reply: string | undefined;
    if (event === 'SessionStart' && report.source === 'compact') {
      // Compaction finished inside a turn: the same conversation carries on.
      w.info.sessionId = session;
      if (w.info.activity === COMPACTING) w.info.activity = undefined;
    } else if (event === 'SessionStart') {
      // A rewind forks the session to continue the same task; /clear and other forks start a new one.
      const fork = w.rewindFork;
      const rewind = w.rewind || (fork && fork.from === w.info.sessionId && Date.now() < fork.until);
      if (report.source === 'clear' || (!rewind && w.info.sessionId && w.info.sessionId !== session)) this.clearTask(w, report.source === 'clear');
      w.rewindFork = undefined;
      w.info.sessionId = session;
      w.pendingFork = undefined;
      w.subSessions.clear();
      w.lastTool.clear();
      w.currentTool = undefined;
      w.completedTool = undefined;
      w.activeTool.clear();
      w.bootBlocked = false;
      w.settingUp = false;
      w.queued = 0;
      w.sentQueue = [];
      w.info.activity = undefined;
      this.context.setStatus(w, 'idle');
      this.context.delivery.sendLaunchPrompt(w);
    } else if (event === 'UserPromptSubmit') {
      w.bootBlocked = false;
      w.currentTool = undefined;
      w.info.action = undefined;
      if (typeof report.prompt === 'string') {
        // The office's reminders after the owner's words (an Orchestrator prompt's floor) aren't what was asked.
        const said = withoutReminders(report.prompt) || report.prompt;
        w.info.activity = truncate(said, 80);
        this.context.notePrompt(w, said);
      }
      this.context.setStatus(w, 'working');
    } else if (event === 'PreToolUse') this.toolStarted(w, session, report);
    else if (event === 'PostToolUse') {
      if (w.currentTool && (!report.tool_name || w.currentTool.name === report.tool_name)) {
        w.completedTool = { ...w.currentTool, at: w.hookAt || Date.now() };
        w.currentTool = undefined;
      }
      w.activeTool.delete(session);
      // The structured list (PreToolUse has it as typed text).
      if (report.tool_name === 'TodoWrite') this.noteTodos(w, report.tool_input);
      this.noteOutcome(w, report, false);
      this.refreshAfter(w, report);
      // A hook command from before SubagentStop: a subagent that asked has finished once its Task returns.
      if (w.hookVersion < HOOK_VERSION && w.asking && w.asking.session !== session && report.tool_name === 'Task') this.context.setStatus(w, 'working');
      else this.toolFinished(w, session, report);
      if (replies && w.outbox.length) {
        reply = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: officeSays(w.outbox.join('\n\n')) } });
        w.outbox = [];
      }
    } else if (event === 'Notification') {
      // The hooks reference says a cancelled turn sends idle_prompt instead of Stop; Droid 1.1.0 sends Stop.
      if (report.notification_type === 'idle_prompt' && (w.info.status === 'working' || (w.info.status === 'needs_input' && !w.bootBlocked))) this.context.setStatus(w, 'done');
      else this.notified(w, session, report);
    } else if (event === 'Stop') {
      w.activeTool.delete(session);
      reply = this.stopped(w, report, replies);
    } else if (event === 'SubagentStop') {
      w.activeTool.delete(session);
      // A Task subagent finished: a question it was asking in this terminal is over.
      if (w.info.status === 'needs_input' && w.asking && w.asking.session !== session) this.context.setStatus(w, 'working');
      const name = typeof report.task_name === 'string' && report.task_name ? report.task_name : 'A subagent';
      if (w.info.status === 'working') w.info.activity = truncate(`${name} finished${typeof report.task_error === 'string' && report.task_error ? ' with an error' : ''}`, 80);
    } else if (event === 'PreCompact') w.info.activity = COMPACTING;
    // /model can change it between turns, and droid writes the file a moment after SessionStart.
    if (event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'Stop') this.context.refreshModel(w);
    return reply;
  }

  /**
   * Its own session's Stop. A Stop hook that blocks (the office's own, below, or another one the
   * owner set up) keeps the turn going, so a Stop is only done once STOP_GRACE_MS passes with no
   * other hook (see settleStop). With `replies`, the office blocks it to hand over what it has for
   * the worker, but never a Stop that a block already continued (stop_hook_active), so it can't loop,
   * nor one right after a cancel or with a queued message to run next.
   */
  private stopped(w: Worker, report: Record<string, unknown>, replies: boolean): string | undefined {
    // Droid's queue was emptied some other way (Ctrl+R in its terminal): nothing runs next.
    if (w.queued > 0 && w.term && readDroidQueue(screenRows(w.term))?.length === 0) {
      w.queued = 0;
      w.sentQueue = w.sentQueue.filter((s) => s.group !== 'queued');
    }
    // A message queued with Ctrl+Enter runs next, without a UserPromptSubmit of its own.
    if (w.queued > 0) {
      w.queued--;
      w.sentQueue.shift();
      this.context.nextTurn(w.info);
      return undefined;
    }
    const cancelled = w.cancelAt !== undefined && Date.now() - w.cancelAt < CANCEL_MS;
    if (replies && !cancelled && report.stop_hook_active !== true && (w.info.status === 'working' || w.info.status === 'needs_input')) {
      const notes = [...w.outbox];
      const more = this.context.beforeStop(w.info);
      if (more) notes.push(more);
      if (notes.length) {
        w.outbox = [];
        return JSON.stringify({ decision: 'block', reason: officeSays(notes.join('\n\n')) });
      }
    }
    // Already at rest: a queued turn that used no tools ended. It doesn't finish (and ding) again.
    if (w.info.status !== 'working' && (w.info.status !== 'needs_input' || w.bootBlocked)) return undefined;
    const at = Date.now();
    w.stopAt = at;
    setTimeout(() => this.settleStop(w, at), STOP_GRACE_MS).unref();
    return undefined;
  }

  /**
   * A Stop's grace passed with no other hook: the turn is done, unless its screen shows it still
   * going. Asked again every second (see reconcile) while it isn't.
   */
  settleStop(w: Worker, at: number, now = Date.now()) {
    if (w.stopAt !== at || this.context.closing() || this.context.get(w.info.id) !== w || !w.term) return;
    if (w.info.status !== 'working' && w.info.status !== 'needs_input') return;
    const screen = readDroidScreen(screenRows(w.term));
    // A dialog is up, or another Stop hook continued the turn before any tool: its spinner is still
    // printing. One quoted in a reply doesn't print, and doesn't hold the finish up.
    if (screen === 'asking' || (screen === 'busy' && now - w.outputAt < STOP_GRACE_MS)) return;
    this.context.setStatus(w, 'done');
  }

  /** A tool call finished: what it may have changed is looked at now rather than on the next timer (see hook-refresh.ts). */
  private refreshAfter(w: Worker, report: Record<string, unknown>) {
    const refresh = toolRefresh(report.tool_name, report.tool_input);
    if (!refresh) return;
    if (refresh.branch) void this.context.syncBranch(w);
    this.context.tool(w.info.id, refresh);
  }

  /**
   * A hook from one of its subagents. It works inside the worker's turn, and its permission prompts
   * and questions show in the worker's terminal; its own start, prompt and end are not the worker's.
   */
  private subagentHook(w: Worker, event: string, report: Record<string, unknown>, live: boolean): undefined {
    const session = report.session_id as string;
    if (event === 'PreToolUse') this.toolStarted(w, session, report, true);
    else if (event === 'PostToolUse') {
      w.activeTool.delete(session);
      this.noteOutcome(w, report, false);
      if (live) this.refreshAfter(w, report);
      this.toolFinished(w, session, report);
    } else if (event === 'Stop') w.activeTool.delete(session);
    else if (event === 'Notification') this.notified(w, session, report, true);
    else if ((event === 'SessionStart' || event === 'UserPromptSubmit') && (w.info.status === 'done' || w.info.status === 'idle')) this.context.setStatus(w, 'working');
    return undefined;
  }

  private toolStarted(w: Worker, session: string, report: Record<string, unknown>, sub = false) {
    const tool = report.tool_name;
    if (typeof tool === 'string') w.lastTool.set(session, { tool, input: report.tool_input });
    if (ASK_TOOLS.has(tool)) {
      w.activeTool.delete(session);
      this.context.setStatus(w, 'needs_input');
      w.asking = { session, tool: tool as string };
      const input = report.tool_input && typeof report.tool_input === 'object' ? (report.tool_input as Record<string, unknown>) : {};
      const questions = inputQuestions(input);
      if (questions.length) {
        w.info.ask = { kind: 'question', questions, ...(sub ? { sub: true as const } : {}) };
        w.info.activity = truncate(questions.length > 1 ? `${questions[0].question} (+${questions.length - 1} more)` : questions[0].question, 80);
        if (w.pty?.id) this.context.persist();
      }
      return;
    }
    const summary = describeTool(report);
    w.info.activity = summary;
    if (!sub) w.currentTool = { name: String(tool ?? 'tool'), summary, at: w.hookAt || Date.now() };
    if (typeof tool === 'string') w.activeTool.set(session, { tool, input: report.tool_input, startedAt: w.hookAt || Date.now() });
    w.info.action = toolAction(tool, report.tool_input);
    // Moving on means its question was answered, unless another session is the one asking.
    if (w.info.status !== 'needs_input' || !w.asking || w.asking.session === session) this.context.setStatus(w, 'working');
  }

  /** A tool the session asked about (permission to run it, or a question) has run: it was answered. */
  private toolFinished(w: Worker, session: string, report: Record<string, unknown>) {
    const { asking } = w;
    if (w.info.status !== 'needs_input' || !asking || asking.session !== session) return;
    if (asking.tool === undefined || asking.tool === report.tool_name) this.context.setStatus(w, 'working');
  }

  private notified(w: Worker, session: string, report: Record<string, unknown>, sub = false) {
    if (report.notification_type !== 'permission_prompt' && report.notification_type !== 'elicitation_dialog') return;
    const call = w.lastTool.get(session);
    const permission = report.notification_type === 'permission_prompt' && call && !ASK_TOOLS.has(call.tool) ? permissionAsk(call.tool, call.input, sub) : undefined;
    const question = w.info.status === 'needs_input' && w.info.ask?.kind === 'question' ? w.info.activity : undefined;
    w.info.activity = permission ? truncate(permissionLine(permission), 80) : (question ?? (typeof report.message === 'string' ? truncate(report.message, 80) : 'Waiting for input'));
    this.context.setStatus(w, 'needs_input');
    w.asking = { session, tool: call?.tool };
    if (permission) {
      w.info.ask = permission;
      if (w.pty?.id) this.context.persist();
    }
  }

  /**
   * A tool call finished. Tests or a build that failed again (by exit code, or by the summary it
   * printed when the exit code was piped away) and the worker puts its head in its hands, until its
   * next tool call; a passing run ends the streak.
   */
  private noteOutcome(w: Worker, payload: any, failed: boolean) {
    if (payload?.is_interrupt || toolAction(payload?.tool_name, payload?.tool_input) !== 'test') return;
    const res = payload?.tool_response;
    const output = [payload?.error, res?.stdout, res?.stderr].filter((s) => typeof s === 'string').join('\n');
    if (!failed && !outputFailed(output)) {
      w.failStreak = 0;
      return;
    }
    if (++w.failStreak < FAILS_TO_DESPAIR || w.info.action === 'failing') return;
    w.info.action = 'failing';
    this.context.update(w);
  }

  /** Its latest TodoWrite list; one with no items clears it. */
  private noteTodos(w: Worker, input: unknown) {
    const todos = todoProgress(input);
    if (todos) {
      w.info.todos = todos;
      w.todoSteps = todoItems(input);
    } else {
      delete w.info.todos;
      delete w.todoSteps;
    }
  }

  private clearTask(w: Worker, cleared: boolean) {
    w.taskEpoch++;
    w.info.taskSince = cleared ? Date.now() : undefined;
    w.info.task = undefined;
    delete w.info.todos;
    delete w.todoSteps;
    this.context.update(w);
    this.context.persist();
  }
}

// ---------------------------------------------------------------------------
// Daemon session notifications, snapshot hydration, tail() and search()
// ---------------------------------------------------------------------------

const VALID_WORKING_STATES = new Set<string>(['idle', 'thinking', 'streaming_assistant_message', 'executing_tool', 'waiting_for_tool_confirmation', 'compacting_conversation', 'searching_web', 'fetching_url']);

const RETRY_CLEAR_EVENTS = new Set<string>([
  'assistant_text_delta',
  'thinking_text_delta',
  'create_message',
  'tool_call',
  'tool_result',
  'tool_progress_update',
  'tool_execution_phase_changed',
  'droid_working_state_changed',
  'agent_turn_completed',
  'error',
]);

const MAX_THINKING_DURATIONS = 500;
const MAX_CHILD_SESSIONS = 200;
const TAIL_LINE_MAX = 4000;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function validWorkingState(raw: unknown): ThreadLiveWorking {
  return typeof raw === 'string' && VALID_WORKING_STATES.has(raw) ? (raw as ThreadLiveWorking) : 'idle';
}

export function syncWorkerQueueInfo(w: Worker): void {
  const state = buildDaemonQueueState(w.daemonQueue, w.outbox);
  if (state.count > 0) w.info.queue = state;
  else delete w.info.queue;
}

export function applyDaemonSettings(w: Worker, raw: unknown): boolean {
  const top = record(raw);
  const inner = 'settings' in top ? record(top.settings) : {};
  const model = str(top.routedModelId) ?? str(inner.routedModelId) ?? str(top.modelId) ?? str(inner.modelId) ?? str(top.model) ?? str(inner.model);
  const effortRaw = str(top.routedReasoningEffort) ?? str(inner.routedReasoningEffort) ?? str(top.reasoningEffort) ?? str(inner.reasoningEffort);
  const interactionMode = str(top.interactionMode) ?? str(inner.interactionMode);
  const autonomyLevel = str(top.autonomyLevel) ?? str(inner.autonomyLevel);

  const prevJson = JSON.stringify([w.liveSettings, w.info.activeModel, w.info.activeEffort]);
  const next: ThreadSessionSettings = { ...w.liveSettings };
  if (model) next.model = model;
  if (effortRaw) {
    if (effortRaw === 'none') delete next.reasoningEffort;
    else next.reasoningEffort = effortRaw;
  }
  if (interactionMode) next.interactionMode = interactionMode;
  if (autonomyLevel) next.autonomyLevel = autonomyLevel;
  if (Object.keys(next).length > 0) w.liveSettings = next;

  if (model) w.info.activeModel = model;
  if (effortRaw) {
    if (isAgentEffort(effortRaw)) w.info.activeEffort = effortRaw;
    else if (effortRaw === 'none') delete w.info.activeEffort;
  }
  return JSON.stringify([w.liveSettings, w.info.activeModel, w.info.activeEffort]) !== prevJson;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    const r = record(item);
    if (typeof r.text === 'string' && r.text) parts.push(r.text);
  }
  return parts.join('\n');
}

function applyTodosFromInput(w: Worker, input: unknown): void {
  const todos = todoProgress(input);
  if (todos) {
    w.info.todos = todos;
    w.todoSteps = todoItems(input);
  } else {
    delete w.info.todos;
    delete w.todoSteps;
  }
}

export function applyDaemonSnapshot(w: Worker, rawSnapshot: unknown): { isBusy: boolean; workingState: ThreadLiveWorking } {
  const snap = record(rawSnapshot);
  const sessionObj = record(snap.session);
  const rawMsgs = Array.isArray(snap.messages) ? snap.messages : Array.isArray(sessionObj.messages) ? sessionObj.messages : undefined;
  if (rawMsgs) {
    w.messages.snapshot(rawMsgs);
    w.screenDirty = true;
    if (!w.info.todos) {
      let lastTodoInput: unknown;
      const errorIds = new Set<string>();
      for (const m of rawMsgs) {
        const mr = record(m);
        const content = Array.isArray(mr.content) ? mr.content : [];
        for (const c of content) {
          const cr = record(c);
          if (cr.type === 'tool_result' && cr.is_error === true && typeof cr.tool_use_id === 'string') errorIds.add(cr.tool_use_id);
        }
      }
      for (const m of rawMsgs) {
        const mr = record(m);
        const content = Array.isArray(mr.content) ? mr.content : [];
        for (const c of content) {
          const cr = record(c);
          if (cr.type === 'tool_use' && cr.name === 'TodoWrite' && typeof cr.id === 'string' && !errorIds.has(cr.id)) {
            lastTodoInput = cr.input;
          }
        }
      }
      if (lastTodoInput !== undefined) applyTodosFromInput(w, lastTodoInput);
    }
  }

  applyDaemonSettings(w, snap.settings ?? sessionObj.settings ?? snap);

  const title = str(snap.title) ?? str(sessionObj.title);
  if (title && !/^new session$/i.test(title) && !/^droid$/i.test(title)) {
    const clean = title.replace(/^[^\p{L}\p{N}]+/u, '').trim();
    if (clean) w.info.title = clean;
  }

  const rawQueue = snap.queuedMessages ?? snap.queuedMessagesSnapshot ?? sessionObj.queuedMessages;
  if (Array.isArray(rawQueue)) {
    w.daemonQueue = parseDaemonQueueList(rawQueue);
    syncWorkerQueueInfo(w);
  }

  const wsRaw = str(snap.workingState) ?? str(sessionObj.workingState);
  const workingState = validWorkingState(wsRaw);
  const isBusy = snap.isBusy === true || sessionObj.isBusy === true || workingState !== 'idle';
  w.workingState = isBusy && workingState === 'idle' ? 'thinking' : workingState;
  return { isBusy, workingState: w.workingState };
}

export interface DaemonNotificationCallbacks {
  now?: () => number;
  setStatus(w: Worker, status: WorkerStatus): void;
  clockWork(info: WorkerInfo, status: WorkerStatus, now?: number): void;
  emitUpdate(w: Worker): void;
  persist(): void;
  syncBranch(w: Worker): Promise<void>;
  tool(workerId: string, refresh: ToolRefresh): void;
  notePrompt(w: Worker, text: string): void;
  setTitle(w: Worker, title: string): void;
  beforeStop?(info: WorkerInfo): string | undefined;
  nextTurn?(info: WorkerInfo): void;
  sendNudge(w: Worker, text: string): void;
}

function capMap<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function applyDaemonNotification(w: Worker, sessionId: string, raw: unknown, cb: DaemonNotificationCallbacks): void {
  const n = record(raw);
  const type = typeof n.type === 'string' ? n.type : '';
  if (!type) return;
  const now = cb.now ? cb.now() : Date.now();
  const isSub = sessionId !== w.info.sessionId;

  w.hookAt = now;
  w.outputAt = now;
  if (!isSub) {
    w.messages.event(raw);
    w.screenDirty = true;
  }

  if (!isSub && w.retryState && RETRY_CLEAR_EVENTS.has(type)) {
    w.retryState = undefined;
  }

  if (isSub) {
    applySubagentNotification(w, sessionId, type, n, now, cb);
    return;
  }

  switch (type) {
    case 'droid_working_state_changed': {
      const next = validWorkingState(n.newState);
      w.workingState = next;
      if (next === 'compacting_conversation') {
        w.info.activity = COMPACTING;
      } else if (w.info.activity === COMPACTING) {
        w.info.activity = undefined;
      }
      if (next !== 'idle' && w.info.status !== 'working' && w.info.status !== 'needs_input') {
        cb.clockWork(w.info, 'working', now);
        cb.setStatus(w, 'working');
      } else {
        cb.emitUpdate(w);
      }
      break;
    }

    case 'thinking_text_delta': {
      const messageId = typeof n.messageId === 'string' ? n.messageId : '';
      const blockIndex = typeof n.blockIndex === 'number' && Number.isInteger(n.blockIndex) ? n.blockIndex : 0;
      const delta = typeof n.textDelta === 'string' ? n.textDelta : '';
      if (!delta) break;
      const key = `${messageId}:${blockIndex}`;
      let since = w.thinkingStartedAt.get(key);
      if (since === undefined) {
        since = now;
        w.thinkingStartedAt.set(key, since);
        capMap(w.thinkingStartedAt, MAX_THINKING_DURATIONS);
      }
      if (w.liveStream?.kind === 'thinking' && w.liveStream.messageId === messageId && w.liveStream.blockIndex === blockIndex) {
        w.liveStream = { ...w.liveStream, text: (w.liveStream.text + delta).slice(-64_000) };
      } else {
        w.liveStream = { kind: 'thinking', messageId, blockIndex, since, text: delta.slice(-64_000) };
      }
      if (w.workingState === 'streaming_assistant_message' || w.workingState === 'idle') w.workingState = 'thinking';
      if (w.info.status !== 'working' && w.info.status !== 'needs_input') {
        cb.clockWork(w.info, 'working', now);
        cb.setStatus(w, 'working');
      }
      break;
    }

    case 'thinking_text_complete': {
      const messageId = typeof n.messageId === 'string' ? n.messageId : '';
      const blockIndex = typeof n.blockIndex === 'number' && Number.isInteger(n.blockIndex) ? n.blockIndex : 0;
      const key = `${messageId}:${blockIndex}`;
      const started = w.thinkingStartedAt.get(key);
      w.thinkingStartedAt.delete(key);
      const explicit = typeof n.durationMs === 'number' && Number.isFinite(n.durationMs) && n.durationMs >= 0 ? Math.round(n.durationMs) : undefined;
      const durationMs = explicit ?? (started !== undefined ? Math.max(0, now - started) : undefined);
      if (messageId && durationMs !== undefined) {
        w.thinkingDurations.set(key, durationMs);
        capMap(w.thinkingDurations, MAX_THINKING_DURATIONS);
      }
      if (w.liveStream?.kind === 'thinking' && w.liveStream.messageId === messageId && w.liveStream.blockIndex === blockIndex) {
        w.liveStream = undefined;
      }
      cb.emitUpdate(w);
      break;
    }

    case 'assistant_text_delta': {
      const messageId = typeof n.messageId === 'string' ? n.messageId : '';
      const blockIndex = typeof n.blockIndex === 'number' && Number.isInteger(n.blockIndex) ? n.blockIndex : 0;
      const delta = typeof n.textDelta === 'string' ? n.textDelta : '';
      if (!delta) break;
      if (w.liveStream?.kind === 'text' && w.liveStream.messageId === messageId && w.liveStream.blockIndex === blockIndex) {
        w.liveStream = { ...w.liveStream, text: (w.liveStream.text + delta).slice(-64_000) };
      } else {
        w.liveStream = { kind: 'text', messageId, blockIndex, since: now, text: delta.slice(-64_000) };
      }
      if (w.workingState === 'thinking' || w.workingState === 'idle') w.workingState = 'streaming_assistant_message';
      if (w.info.status !== 'working' && w.info.status !== 'needs_input') {
        cb.clockWork(w.info, 'working', now);
        cb.setStatus(w, 'working');
      }
      break;
    }

    case 'create_message': {
      const reqId = str(n.requestId);
      if (reqId) {
        const before = w.daemonQueue.length;
        w.daemonQueue = w.daemonQueue.filter((q) => q.requestId !== reqId);
        if (w.daemonQueue.length !== before) syncWorkerQueueInfo(w);
      }
      const msg = record(n.message);
      const msgId = str(msg.id);
      if (msg.role === 'assistant') {
        if (msgId && w.liveStream?.messageId === msgId) w.liveStream = undefined;
      } else if (msg.role === 'user') {
        w.currentTool = undefined;
        w.info.action = undefined;
        const rawText = contentToText(msg.content);
        const said = (withoutReminders(rawText) || rawText).trim();
        if (said && !said.startsWith('Droid Office notice:')) {
          w.stopNudged = false;
          w.info.activity = truncate(said, 80);
          cb.notePrompt(w, said);
        }
        if (w.info.status !== 'working' && w.info.status !== 'needs_input') {
          cb.clockWork(w.info, 'working', now);
          cb.setStatus(w, 'working');
        } else {
          cb.emitUpdate(w);
        }
        break;
      }
      cb.emitUpdate(w);
      break;
    }

    case 'assistant_message_retracted': {
      const msgId = str(n.messageId);
      if (msgId && w.liveStream?.messageId === msgId) w.liveStream = undefined;
      cb.emitUpdate(w);
      break;
    }

    case 'tool_call': {
      const toolUse = record(n.toolUse);
      const toolUseId = str(toolUse.id);
      const toolName = str(toolUse.name) ?? 'Tool';
      if (!toolUseId) break;
      w.lastTool.set(sessionId, { tool: toolName, input: toolUse.input });
      if (ASK_TOOLS.has(toolName)) break;
      const summary = describeTool({ tool_name: toolName, tool_input: toolUse.input });
      w.info.activity = summary;
      w.currentTool = { name: toolName, summary, at: now };
      w.activeTool.set(toolUseId, { tool: toolName, input: toolUse.input, startedAt: now });
      w.liveTools.set(toolUseId, { toolUseId, name: toolName, input: toolUse.input, startedAt: now });
      w.info.action = toolAction(toolName, toolUse.input);
      w.workingState = 'executing_tool';
      cb.clockWork(w.info, 'working', now);
      if (w.info.status !== 'needs_input') cb.setStatus(w, 'working');
      cb.emitUpdate(w);
      break;
    }

    case 'tool_progress_update': {
      const toolUseId = str(n.toolUseId);
      if (!toolUseId) break;
      const toolName = str(n.toolName) ?? 'Tool';
      const update = record(n.update);
      const subId = str(update.subagentSessionId);
      if (subId) {
        w.subSessions.add(subId);
        w.childSessions.set(`tool:${toolUseId}`, subId);
        capMap(w.childSessions, MAX_CHILD_SESSIONS);
      }
      let lt = w.liveTools.get(toolUseId);
      if (!lt) {
        lt = { toolUseId, name: toolName, startedAt: now };
        w.liveTools.set(toolUseId, lt);
      }
      const rawOut = typeof update.fullOutput === 'string' ? update.fullOutput : typeof update.output === 'string' ? update.output : typeof update.text === 'string' ? update.text : undefined;
      if (rawOut !== undefined) {
        const lines = rawOut.replace(/\r/g, '').split('\n');
        lt.output = lines.slice(-40).join('\n');
        lt.more = lines.length > 40 ? lines.length - 40 : undefined;
      }
      break;
    }

    case 'child_session_available': {
      const childId = str(n.childSessionId);
      const toolUseId = str(n.toolUseId);
      if (childId) {
        w.subSessions.add(childId);
        if (toolUseId) {
          w.childSessions.set(`tool:${toolUseId}`, childId);
          capMap(w.childSessions, MAX_CHILD_SESSIONS);
        }
        cb.emitUpdate(w);
      }
      break;
    }

    case 'tool_result': {
      const toolUseId = str(n.toolUseId);
      const lt = toolUseId ? w.liveTools.get(toolUseId) : undefined;
      const last = w.lastTool.get(sessionId);
      const toolName = lt?.name ?? last?.tool ?? w.currentTool?.name;
      const toolInput = lt?.input ?? last?.input;
      if (toolUseId) {
        w.liveTools.delete(toolUseId);
        w.activeTool.delete(toolUseId);
      }
      if (w.currentTool && (!toolName || w.currentTool.name === toolName)) {
        w.completedTool = { ...w.currentTool, at: now };
        w.currentTool = undefined;
      }
      const isError = n.isError === true;
      if (toolName === 'TodoWrite' && !isError) {
        applyTodosFromInput(w, toolInput);
      }
      if (toolAction(toolName, toolInput) === 'test') {
        const out = contentToText(n.content);
        if (!isError && !outputFailed(out)) {
          w.failStreak = 0;
        } else if (++w.failStreak >= FAILS_TO_DESPAIR) {
          w.info.action = 'failing';
        }
      }
      const refresh = toolRefresh(toolName, toolInput);
      if (refresh) {
        if (refresh.branch) void cb.syncBranch(w);
        cb.tool(w.info.id, refresh);
      }
      cb.emitUpdate(w);
      cb.persist();
      break;
    }

    case 'queued_messages_changed': {
      w.daemonQueue = parseDaemonQueueList(n.messages);
      syncWorkerQueueInfo(w);
      cb.emitUpdate(w);
      break;
    }

    case 'queued_messages_discarded': {
      const ids = new Set<string>();
      if (typeof n.requestId === 'string' && n.requestId) ids.add(n.requestId);
      if (Array.isArray(n.drainedRequestIds)) {
        for (const id of n.drainedRequestIds) if (typeof id === 'string' && id) ids.add(id);
      }
      if (Array.isArray(n.messages)) {
        for (const m of n.messages) {
          const r = record(m);
          if (typeof r.requestId === 'string' && r.requestId) ids.add(r.requestId);
        }
      }
      w.daemonQueue = ids.size > 0 ? w.daemonQueue.filter((q) => !ids.has(q.requestId)) : [];
      syncWorkerQueueInfo(w);
      cb.emitUpdate(w);
      break;
    }

    case 'queued_message_handed_back': {
      const reqId = str(n.requestId);
      if (reqId) {
        w.daemonQueue = w.daemonQueue.filter((q) => q.requestId !== reqId);
        syncWorkerQueueInfo(w);
        cb.emitUpdate(w);
      }
      break;
    }

    case 'settings_updated': {
      if (applyDaemonSettings(w, n)) {
        cb.emitUpdate(w);
        cb.persist();
      }
      break;
    }

    case 'session_title_updated': {
      if (typeof n.title === 'string') cb.setTitle(w, n.title);
      break;
    }

    case 'session_compacted': {
      // Pre-cutoff TodoWrite plan progress is intentionally retained across compaction (#11).
      if (w.info.activity === COMPACTING) w.info.activity = undefined;
      cb.emitUpdate(w);
      cb.persist();
      break;
    }

    case 'llm_retry': {
      const attempt = typeof n.attempt === 'number' && Number.isInteger(n.attempt) && n.attempt > 0 ? n.attempt : 1;
      const maxAttempts = typeof n.maxAttempts === 'number' && Number.isInteger(n.maxAttempts) && n.maxAttempts > 0 ? n.maxAttempts : undefined;
      const detail = `Retrying the model request (attempt ${attempt})...`;
      w.retryState = {
        retrying: true,
        attempt,
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
        detail,
      };
      w.info.activity = detail;
      cb.emitUpdate(w);
      break;
    }

    case 'error': {
      const msg = str(n.message) ?? str(n.error);
      if (msg) {
        w.retryState = { retrying: false, detail: msg.slice(0, 160) };
        w.info.activity = truncate(msg, 80);
        cb.emitUpdate(w);
      }
      break;
    }

    case 'agent_turn_completed': {
      for (const [key, startedAt] of w.thinkingStartedAt) {
        if (!w.thinkingDurations.has(key)) {
          w.thinkingDurations.set(key, Math.max(0, now - startedAt));
          capMap(w.thinkingDurations, MAX_THINKING_DURATIONS);
        }
      }
      w.thinkingStartedAt.clear();
      w.liveStream = undefined;
      w.liveTools.clear();
      w.activeTool.clear();
      w.currentTool = undefined;
      w.workingState = 'idle';

      const hasAfterTurn = w.daemonQueue.some((q) => q.queuePlacement === 'end_of_loop');
      if (hasAfterTurn) {
        cb.nextTurn?.(w.info);
        cb.emitUpdate(w);
        break;
      }

      const reason = str(n.reason);
      const cancelled = reason === 'cancelled' || reason === 'interrupted' || (w.cancelAt !== undefined && now - w.cancelAt < CANCEL_MS);
      if (!cancelled && !w.compacting) {
        const notes = w.outbox.splice(0);
        if (notes.length) syncWorkerQueueInfo(w);
        const more = !w.stopNudged ? cb.beforeStop?.(w.info) : undefined;
        if (more) {
          w.stopNudged = true;
          notes.push(more);
        }
        if (notes.length && w.info.sessionId) {
          cb.sendNudge(w, officeSays(notes.join('\n\n')));
          cb.persist();
          break;
        }
      }

      w.stopNudged = false;
      cb.clockWork(w.info, 'done', now);
      cb.setStatus(w, 'done');
      cb.persist();
      break;
    }
  }
}

function applySubagentNotification(w: Worker, subSessionId: string, type: string, n: Record<string, unknown>, now: number, cb: DaemonNotificationCallbacks): void {
  if (type === 'tool_call') {
    const toolUse = record(n.toolUse);
    const toolUseId = str(toolUse.id);
    const toolName = str(toolUse.name) ?? 'Tool';
    if (!toolUseId || ASK_TOOLS.has(toolName)) return;
    const key = `${subSessionId}:${toolUseId}`;
    w.activeTool.set(key, { tool: toolName, input: toolUse.input, startedAt: now });
    w.liveTools.set(key, { toolUseId, name: toolName, input: toolUse.input, startedAt: now, session: subSessionId });
    w.info.activity = describeTool({ tool_name: toolName, tool_input: toolUse.input });
    w.info.action = toolAction(toolName, toolUse.input);
    cb.emitUpdate(w);
  } else if (type === 'tool_result') {
    const toolUseId = str(n.toolUseId);
    const key = toolUseId ? `${subSessionId}:${toolUseId}` : undefined;
    const lt = key ? w.liveTools.get(key) : undefined;
    if (key) {
      w.liveTools.delete(key);
      w.activeTool.delete(key);
    }
    const refresh = toolRefresh(lt?.name, lt?.input);
    if (refresh) {
      if (refresh.branch) void cb.syncBranch(w);
      cb.tool(w.info.id, refresh);
    }
    cb.emitUpdate(w);
  } else if (type === 'agent_turn_completed') {
    for (const k of [...w.liveTools.keys()]) {
      if (k.startsWith(`${subSessionId}:`)) w.liveTools.delete(k);
    }
    for (const k of [...w.activeTool.keys()]) {
      if (k.startsWith(`${subSessionId}:`)) w.activeTool.delete(k);
    }
    cb.emitUpdate(w);
  }
}

function clampTailLine(line: string): string {
  const trimmed = line.replace(/\r/g, '').trimEnd();
  return trimmed.length > TAIL_LINE_MAX ? `…${trimmed.slice(-TAIL_LINE_MAX)}` : trimmed;
}

function pushTextLines(out: string[], raw: string, prefixFirst?: string): void {
  const split = raw.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < split.length; i++) {
    const text = i === 0 && prefixFirst ? `${prefixFirst}${split[i]}` : split[i];
    out.push(clampTailLine(text));
  }
}

function summarizeToolInputLine(name: string, input: unknown): string {
  const r = record(input);
  const arg = str(r.command) ?? str(r.cmd) ?? str(r.file_path) ?? str(r.filePath) ?? str(r.path) ?? str(r.pattern) ?? str(r.url) ?? str(r.query);
  return arg ? `[${name}] ${arg.replace(/\s+/g, ' ').slice(0, 200)}` : `[${name}]`;
}

function readTranscriptTailLines(sessionFile: string): string[] {
  let chunk = '';
  try {
    const size = statSync(sessionFile).size;
    if (size <= 0) return [];
    const readLen = Math.min(size, 256 * 1024);
    const fd = openSync(sessionFile, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      const bytesRead = readSync(fd, buf, 0, readLen, size - readLen);
      chunk = buf.subarray(0, bytesRead).toString('utf8');
      if (size > readLen) {
        const nl = chunk.indexOf('\n');
        if (nl >= 0) chunk = chunk.slice(nl + 1);
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const rowLine of chunk.split('\n')) {
    if (!rowLine.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = record(JSON.parse(rowLine));
    } catch {
      continue;
    }
    if (row.type !== 'message') continue;
    const msg = record(row.message);
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    if ([msg, row].some((o) => Object.keys(o).some((k) => k.startsWith('hook')))) continue;
    if (msg.visibility && msg.visibility !== 'both' && msg.visibility !== 'user_only') continue;
    if (typeof msg.content === 'string') {
      const text = msg.role === 'user' ? withoutReminders(msg.content) || msg.content : msg.content;
      if (text.trim()) pushTextLines(out, text, msg.role === 'user' ? '› ' : undefined);
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      const pr = record(part);
      if (pr.type === 'text' && typeof pr.text === 'string' && pr.text.trim()) {
        const text = msg.role === 'user' ? withoutReminders(pr.text) || pr.text : pr.text;
        pushTextLines(out, text, msg.role === 'user' ? '› ' : undefined);
      } else if (pr.type === 'thinking' && typeof pr.thinking === 'string' && pr.thinking.trim()) {
        pushTextLines(out, pr.thinking);
      } else if (pr.type === 'tool_use' && typeof pr.name === 'string') {
        out.push(clampTailLine(summarizeToolInputLine(pr.name, pr.input)));
      } else if (pr.type === 'tool_result') {
        const text = contentToText(pr.content);
        if (text.trim()) {
          const tail = text.replace(/\r\n?/g, '\n').split('\n').slice(-60);
          for (const l of tail) out.push(clampTailLine(l));
        }
      }
    }
  }
  return out;
}

export function renderDaemonWorkerLines(w: Worker, sessionFile?: string): string[] {
  const out: string[] = [];
  const msgs = w.messages.values();
  if (msgs.length > 0) {
    for (const m of msgs) {
      for (const b of m.blocks) {
        if (b.type === 'text' && b.text.trim()) {
          const text = m.role === 'user' ? withoutReminders(b.text) || b.text : b.text;
          pushTextLines(out, text, m.role === 'user' ? '› ' : undefined);
        } else if (b.type === 'thinking' && b.text.trim()) {
          pushTextLines(out, b.text);
        } else if (b.type === 'tool_use') {
          out.push(clampTailLine(summarizeToolInputLine(b.name, b.input)));
        } else if (b.type === 'tool_result' && b.text.trim()) {
          const tail = b.text.replace(/\r\n?/g, '\n').split('\n').slice(-60);
          for (const l of tail) out.push(clampTailLine(l));
        }
      }
    }
  } else if (sessionFile && existsSync(sessionFile)) {
    out.push(...readTranscriptTailLines(sessionFile));
  }

  for (const lt of w.liveTools.values()) {
    if (lt.output?.trim()) {
      for (const l of lt.output.split('\n')) out.push(clampTailLine(l));
    }
  }
  if (w.retryState?.detail) out.push(clampTailLine(w.retryState.detail));

  while (out.length > 0 && !out[out.length - 1]) out.pop();
  if (!out.length && w.info.activity) out.push(clampTailLine(w.info.activity));
  return out;
}

export function tailDaemonWorker(w: Worker, lines: number, sessionFile?: string): string {
  const rendered = renderDaemonWorkerLines(w, sessionFile);
  const want = Math.max(1, lines);
  return rendered.slice(-want).join('\n');
}

export function searchDaemonWorker(w: Worker, needle: string, limit: number, sessionFile?: string): { hits: { text: string; row: number; rows: number }[]; more: boolean } {
  const rendered = renderDaemonWorkerLines(w, sessionFile);
  const seen = new Set<string>();
  const hits: { text: string; row: number; rows: number }[] = [];
  for (let i = rendered.length - 1; i >= 0; i--) {
    const key = searchKey(rendered[i]);
    if (!key.includes(needle) || seen.has(key)) continue;
    if (hits.length === limit) return { hits, more: true };
    seen.add(key);
    hits.push({ text: snippet(rendered[i], needle), row: i, rows: rendered.length });
  }
  return { hits, more: false };
}
