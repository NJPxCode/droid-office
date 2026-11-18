import { randomBytes } from 'node:crypto';
import type headless from '@xterm/headless';
import type serialize from '@xterm/addon-serialize';
import type { WorkerInfo, WorkerStatus } from '../../shared/protocol.js';
import { stripKittyPlaceholders } from '../../shared/kitty.js';
import type { ActiveToolCall, DaemonQueuedEntry } from '../worker-queue.js';
import type { WorktreeOwnership } from '../worktrees.js';
import type { WorkerRetryStatus, WorkerToolSpan } from '../worker-status.js';
import type { Pty } from '../ptys.js';
import type { TodoItem } from '../../shared/todos.js';
import { CloudStreamMessages } from '../factory/cloud-stream-messages.js';
import type { CloudAsk } from '../factory/cloud-ask.js';
import type { LocalImageInput } from '../local-daemon.js';
import type { ScreenFrame } from '../screen-frame.js';
import type { ThreadLiveWorking, ThreadSessionSettings } from '../../shared/thread-live.js';
import type { DaemonLiveToolInput } from '../thread-live.js';

type HeadlessTerminal = InstanceType<typeof headless.Terminal>;

export interface BufferedDaemonPrompt {
  text: string;
  images?: LocalImageInput[];
  queue: boolean;
}

export interface Worker {
  info: WorkerInfo;
  pty?: Pty;
  term?: HeadlessTerminal;
  ser?: InstanceType<typeof serialize.SerializeAddon>;
  /** The screen so far, for a browser opening the terminal (see screen.ts). */
  snapshot?: () => string;
  screenDirty: boolean;
  lastLines: string[];
  keyframeAt: number;
  needsKeyframe: boolean;
  hookToken: string;
  /** True while this agent's session is live or starting on the local droid-daemon. */
  daemonActive: boolean;
  /** True while worktree setup or initialize/load/fork RPC is still completing. */
  daemonLaunching: boolean;
  /** Bumped on halt/kill/clear/new/handoff/rewind to discard stale async completions. */
  daemonGeneration: number;
  /** Cancels headless worktree-setup.cjs if the worker stops before setup finishes. */
  setupAbort?: AbortController;
  /** Prompts submitted while daemonLaunching is true, flushed in order once the session is ready. */
  pendingPrompts: BufferedDaemonPrompt[];
  /** Streamed/hydrated messages for 4 Hz 3D laptop screens, tail() and search(). */
  messages: CloudStreamMessages;
  /** Latest 3D screen frame painted from cloudScreen(messages.slice(-20)). */
  screenFrame?: ScreenFrame;
  /** Current daemon working phase (`droid_working_state_changed` + delta transitions). */
  workingState: ThreadLiveWorking;
  /** Active streaming thinking/assistant block before create_message lands. */
  liveStream?: { kind: 'thinking' | 'text'; text: string; since: number; messageId?: string; blockIndex?: number };
  /** Start times of active thinking blocks (`${messageId}:${blockIndex}` -> epoch ms). */
  thinkingStartedAt: Map<string, number>;
  /** Completed thinking durations (`${messageId}:${blockIndex}` -> durationMs) from `thinking_text_complete`. */
  thinkingDurations: Map<string, number>;
  /** Running tool calls reported by `tool_call` / `tool_progress_update`. */
  liveTools: Map<string, DaemonLiveToolInput & { input?: unknown }>;
  /** Child subagent session links (`tool:${toolUseId}` -> `childSessionId`). */
  childSessions: Map<string, string>;
  /** Effective session settings from `initializeSession`, `loadSession`, and `settings_updated`. */
  liveSettings?: ThreadSessionSettings;
  /** Structured retry/error state from `llm_retry` / `error`, cleared on next progress event. */
  retryState?: WorkerRetryStatus;
  /** Pending `AskUser` questionnaire and partial answers collected so far. */
  askState?: { ask: CloudAsk; answers: string[] };
  /** Structured daemon queue (`EndOfTurn` steering + `EndOfLoop` after-turn). */
  daemonQueue: DaemonQueuedEntry[];
  /** True while `compactSession` (`/compress`, `/compact`, `/handoff`) is in flight. */
  compacting?: boolean;
  /** Prevents `beforeStop` from re-nudging endlessly on consecutive turns without a user prompt. */
  stopNudged?: boolean;
  /** Saved daemon session state across a graceful Office restart (`keep = true`). */
  savedDaemon?: { status: WorkerStatus; acked: boolean; waitingSince?: number; outbox?: string[] };
  /** Child sessions reported by the daemon; their events do not update the parent turn. */
  subSessions: Set<string>;
  /** The latest daemon tool call and input for each session, used to identify the call awaiting input. */
  lastTool: Map<string, { tool: string; input: unknown }>;
  /** Full bounded TodoWrite plan steps alongside WorkerInfo.todos. */
  todoSteps?: TodoItem[];
  /** Current daemon tool span and latest completed span. */
  currentTool?: WorkerToolSpan;
  completedTool?: WorkerToolSpan;
  /** Running tool calls tracked by daemon notifications. */
  activeTool: Map<string, ActiveToolCall>;
  /** The daemon session asking for input and the associated tool. */
  asking?: { session: string; tool?: string };
  /** When the last daemon notification arrived. */
  hookAt: number;
  /** When the worker last produced output or daemon activity. */
  outputAt: number;
  /** Known transcript path for this session, if any. */
  transcript?: string;
  /** Office notices held for an answer or turn completion (see notice). */
  outbox: string[];
  /** When the owner or a visit last requested a daemon interrupt. */
  cancelAt?: number;
  /** Bracketed-paste prompts whose 120ms submit keystroke has not fired yet. */
  inFlight: Set<{ timer: NodeJS.Timeout }>;
  /** Test runs and builds that have failed in a row (see FAILS_TO_DESPAIR). */
  failStreak: number;
  /** Bumped by /clear: a new conversation, so a new task. */
  taskEpoch: number;
  /** Its terminal in the host as of the last save, and how it was doing, to pick back up after a restart. */
  saved?: { ptyId: string; status: WorkerStatus; acked: boolean; waitingSince?: number };
  /** Its Droid session lost an active turn: resuming it sends CARRY_ON_PROMPT. */
  interrupted?: boolean;
  /** Output since its scrollback was last saved to disk. */
  unsaved?: boolean;
  /** Where this run's own output starts, below the scrollback carried over from before. */
  fresh?: { readonly line: number };
  /** Its lost worktree is being put back (see rebuild): the folder coming back mustn't wake it before that's done. */
  rebuilding?: boolean;
  /** Branches present at hire time, per repository; never included in gun dismissal. */
  worktreeOwnership?: Record<string, WorktreeOwnership>;
  /** Worktree setup plan run in the shell PTY or headlessly before the daemon session starts. */
  setupPlan?: string;
  /** The worker is still running its worktree setup plan. */
  settingUp?: boolean;
  /** Until the daemon gives the fork its own id, restarts must fork, never resume the source. */
  pendingFork?: { sessionId: string; prompt?: string };
  /** The rewind the office is running on this session (worker.rewind). */
  rewind?: { entryId: string; since: number };
}

/** Whether startup should recover a turn after a lost daemon session. */
export function midTurn({ info }: Pick<Worker, 'info'>): boolean {
  return info.kind === 'agent' && (info.status === 'working' || info.status === 'needs_input');
}

/** The rows a terminal shows now, its scrollback left out. */
export function screenRows(term: HeadlessTerminal): string[] {
  const buf = term.buffer.active;
  const rows: string[] = [];
  for (let y = buf.baseY; y < buf.baseY + term.rows; y++) rows.push(stripKittyPlaceholders(buf.getLine(y)?.translateToString(true) ?? '').trimEnd());
  return rows;
}

export function newWorker(info: WorkerInfo, hookToken = randomBytes(16).toString('hex')): Worker {
  return {
    info,
    screenDirty: true,
    lastLines: [],
    keyframeAt: 0,
    needsKeyframe: false,
    hookToken,
    daemonActive: false,
    daemonLaunching: false,
    daemonGeneration: 0,
    pendingPrompts: [],
    messages: new CloudStreamMessages(),
    workingState: 'idle',
    thinkingStartedAt: new Map(),
    thinkingDurations: new Map(),
    liveTools: new Map(),
    childSessions: new Map(),
    daemonQueue: [],
    failStreak: 0,
    taskEpoch: 0,
    subSessions: new Set(),
    lastTool: new Map(),
    activeTool: new Map(),
    hookAt: 0,
    outputAt: 0,
    outbox: [],
    inFlight: new Set(),
  };
}
