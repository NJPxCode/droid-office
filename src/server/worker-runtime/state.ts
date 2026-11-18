import { randomBytes } from 'node:crypto';
import type headless from '@xterm/headless';
import type serialize from '@xterm/addon-serialize';
import type { WorkerAsk, WorkerInfo, WorkerStatus } from '../../shared/protocol.js';
import { stripKittyPlaceholders } from '../../shared/kitty.js';
import type { ActiveToolCall, DaemonQueuedEntry, SentPendingMessage } from '../worker-queue.js';
import type { WorktreeOwnership } from '../worktrees.js';
import type { WorkerRetryStatus, WorkerToolSpan } from '../worker-status.js';
import type { Pty } from '../ptys.js';
import type { DroidScreen } from '../droid-screen.js';
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
  leftNeedsInputAt: number;
  keyframeAt: number;
  needsKeyframe: boolean;
  termSeq: number;
  screenParse?: { term: HeadlessTerminal; seq: number; state: DroidScreen | undefined };
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
  /** Droid never reported SessionStart: it's stuck on a login or hooks screen. */
  bootBlocked?: boolean;
  /** The first message for this run of its droid, typed in once droid can take it (see launch), and when the run started. */
  launchPrompt?: { text: string; at: number };
  /**
   * Sessions of the subagents its droid started with the Task tool. Their hooks come with this
   * worker's token but their own session id, and their SessionStart and Stop are theirs, not its.
   */
  subSessions: Set<string>;
  /** The latest tool each session started (PreToolUse), and its input, to know which call a permission prompt is about. */
  lastTool: Map<string, { tool: string; input: unknown }>;
  /** Full bounded TodoWrite plan steps alongside WorkerInfo.todos. */
  todoSteps?: TodoItem[];
  /** Currently executing PreToolUse span, and the latest completed tool span. */
  currentTool?: WorkerToolSpan;
  completedTool?: WorkerToolSpan;
  /** Currently running tool calls per session (set on PreToolUse, cleared on PostToolUse/Stop). */
  activeTool: Map<string, ActiveToolCall>;
  /** Who raised its needs_input from a hook: the session asking, and the tool it asks about. */
  asking?: { session: string; tool?: string };
  /** When its last hook came in, and its terminal last printed something (see reconcile). */
  hookAt: number;
  outputAt: number;
  /** When its own session's Stop came, with no hook since: a finish waiting out STOP_GRACE_MS. */
  stopAt?: number;
  /** The version of the hook command its droid runs (see HOOK_VERSION), as its last hook said. */
  hookVersion: number;
  /** Its session's conversation file, as its hooks name it (transcript_path). */
  transcript?: string;
  /** Office notices for its next tool call or Stop (see notice). */
  outbox: string[];
  /** When the owner (or a visit) last pressed Escape or Ctrl+C in its terminal: a Stop right after is a cancel, never blocked. */
  cancelAt?: number;
  /** Notices left in its outbox when it came to rest wait for the owner to stop typing (see flushOutbox). */
  outboxTimer?: NodeJS.Timeout;
  /** Messages queued with Ctrl+Enter during this turn: each runs after the turn's Stop, as a turn with no UserPromptSubmit. */
  queued: number;
  /** Full texts of messages queued with Ctrl+Enter through the office during this turn. */
  sentQueue: SentPendingMessage[];
  sentQueueSeq: number;
  /** Bracketed-paste prompts whose 120ms submit keystroke has not fired yet. */
  inFlight: Set<{ timer: NodeJS.Timeout; text: string; submit: string; queued: boolean }>;
  /** What its screen has shown since when (see droid-screen.ts). */
  screenSeen?: { state: DroidScreen; since: number };
  /** Test runs and builds that have failed in a row (see FAILS_TO_DESPAIR). */
  failStreak: number;
  /** Bumped by /clear: a new conversation, so a new task. */
  taskEpoch: number;
  /** Its terminal in the host as of the last save, and how it was doing, to pick back up after a restart. */
  saved?: { ptyId: string; status: WorkerStatus; acked: boolean; waitingSince?: number; ask?: WorkerAsk; launchPrompt?: { text: string; at: number }; outbox?: string[] };
  /** Its process went away mid-turn with the office or the terminal host: its next start carries on (CARRY_ON_PROMPT). */
  interrupted?: boolean;
  /** Output since its scrollback was last saved to disk. */
  unsaved?: boolean;
  /** Where this run's own output starts, below the scrollback carried over from before. */
  fresh?: { readonly line: number };
  /** Its lost worktree is being put back (see rebuild): the folder coming back mustn't wake it before that's done. */
  rebuilding?: boolean;
  /** Branches present at hire time, per repository; never included in gun dismissal. */
  worktreeOwnership?: Record<string, WorktreeOwnership>;
  /** The plan its first terminal runs before the agent, to make its new worktree ready (see worktree-setup.ts). */
  setupPlan?: string;
  /** Its terminal is running that plan; when it finished, so the agent gets its own time to start after it. */
  settingUp?: boolean;
  setupDoneAt?: number;
  /** Until SessionStart gives the twin its own id, restarts must fork, never resume the source. */
  pendingFork?: { sessionId: string; prompt?: string };
  /** The rewind the office is driving in this terminal (worker.rewind). */
  rewind?: { entryId: string; since: number };
  /** A completed rewind whose asynchronous SessionStart hook has not arrived yet. */
  rewindFork?: { from: string; until: number };
}

/** Cut off if it stopped now. A turn that already sent its Stop has finished, even before its screen confirms it. */
export function midTurn({ info, bootBlocked, stopAt }: Pick<Worker, 'info' | 'bootBlocked' | 'stopAt'>): boolean {
  return info.kind === 'agent' && stopAt === undefined && (info.status === 'working' || (info.status === 'needs_input' && !bootBlocked));
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
    leftNeedsInputAt: 0,
    keyframeAt: 0,
    needsKeyframe: false,
    termSeq: 0,
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
    hookVersion: 0,
    outbox: [],
    queued: 0,
    sentQueue: [],
    sentQueueSeq: 0,
    inFlight: new Set(),
  };
}
