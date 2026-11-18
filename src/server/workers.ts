import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, writeFileSync, readdirSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import unicode11 from '@xterm/addon-unicode11';
import {
  isAgentEffort,
  type AgentChoice,
  type AgentEffort,
  type GhPull,
  type QueuedMessageItem,
  type TeamBadge,
  type TerminalHit,
  type WorkerInfo,
  type WorkerKind,
  type WorkerRepo,
  type WorkerStatus,
  type WorkerTask,
} from '../shared/protocol.js';
import type { Menu } from '../shared/asks.js';
import { cloudScreen } from '../shared/cloud-screen.js';
import type { ToolRefresh } from './hook-refresh.js';
import { leadBadge, memberBadge } from '../shared/team.js';
import { OFFICE_SHELL_ID } from '../shared/office-shell.js';
import { withImages } from '../shared/drops.js';
import { buildDaemonQueueState, detectBlockingTool, type BlockingToolState, type WorkerQueueState } from './worker-queue.js';
import type { ThreadLiveInputs } from './thread-live.js';
import { WORKSPACE_FILES, WORKTREES_DIR, Worktrees, describeWork, workspaceOf, type WorktreeCleanup, type WorktreeRef, type WorktreeStart, type WorktreeState } from './worktrees.js';
import { checkoutDirty, choosePullBase, pushBranch } from './open-pull.js';
import { normalizeRepo } from '../shared/floors.js';
import { DESK_BY_ID, nextFreeSeat, type DeskDef } from '../shared/layout.js';
import { officePrompt, type PromptSource } from './prompts.js';
import { forgeVars, officeSays, placeholders, PROMPTS, withoutReminders, workerMessageVars } from '../shared/prompts.js';
import { isAsleep, isBusy } from '../shared/status.js';
import { linearTaskOf } from '../shared/linear.js';
import { fallbackTask } from './tasks.js';
import { todosFinished } from '../shared/todos.js';
import type { WorkerRetryStatus, WorkerRuntimeSnapshot } from './worker-status.js';
import { forkRefusal, nearestForkSeat } from '../shared/worker-fork.js';
import { githubPulls } from './github.js';
import type { PullHost, PullRef } from './forge.js';
import { forgeWords, type Forge } from '../shared/floors.js';
import { PtyHost, SCROLLBACK, type Adopted, type Pty } from './ptys.js';
import { DroidSessionReader } from './droid-session.js';
import { validateWorkerEffort, validateWorkerModel } from './agents.js';
import { ScrollbackStore, plainTail, searchTerminal, terminalTail } from './history.js';
import { DropStore, type SharedDropImages } from './drops.js';
import { screenSnapshot, setTerminalResponder } from './screen.js';
import { snapshotScreen, type ScreenFrame } from './screen-frame.js';
import type { Capacity } from './machine.js';
import { runWorktreeSetup, setupStep, writePlan, writeSetupScript, type SetupStep } from './worktree-setup.js';
import type { BuildingAgents } from './building-agent.js';
import { pickUniqueForkName, pickUniqueSeat, pickUniqueWorkerName, readHeadBranch } from './floor-watch.js';
import { LocalDaemon, QueuePlacement, type LocalBase64Image, type LocalImageInput, type OfficeMcpConnectionConfig } from './local-daemon.js';
import { askAnswer, askMenu, askedQuestions, type AskReply, type CloudAsk } from './factory/cloud-ask.js';
import { CloudStreamMessages } from './factory/cloud-stream-messages.js';

import { newWorker, midTurn, screenRows, type Worker } from './worker-runtime/state.js';
import { applyDaemonNotification, applyDaemonSettings, applyDaemonSnapshot, searchDaemonWorker, syncWorkerQueueInfo, tailDaemonWorker } from './worker-runtime/hooks.js';
import { WorkerLaunchSettings } from './worker-runtime/launch-settings.js';
import { childEnv, runAsNode, defaultShell, setupLine, setupFailedNote, resolveAgent, WIN, shellRun } from './worker-runtime/process.js';
import { WorkerStateStore } from './worker-runtime/persistence.js';
import { truncate } from './worker-runtime/activity.js';

export { childEnv, runAsNode, defaultShell, setupLine, setupFailedNote, resolveAgent };

type HeadlessTerminal = InstanceType<typeof headless.Terminal>;
type Worktree = NonNullable<WorkerInfo['worktree']>;

/** Widescreen default PTY dimensions matching the 3D laptop's 106:63 display at 0.6:1.25 cell aspect. */
export const DEFAULT_COLS = 136;
export const DEFAULT_ROWS = 39;

/** Workers' names, and their colors. */
export const NAMES = [
  'Pixel',
  'Byte',
  'Nibble',
  'Sprocket',
  'Widget',
  'Gizmo',
  'Bolt',
  'Cosmo',
  'Dot',
  'Echo',
  'Fizz',
  'Glitch',
  'Hopper',
  'Jinx',
  'Kilo',
  'Lumen',
  'Mochi',
  'Noodle',
  'Orbit',
  'Pip',
  'Quark',
  'Rivet',
  'Sparky',
  'Tofu',
  'Uno',
  'Volt',
  'Waffle',
  'Zippy',
];
export const COLORS = ['#ff8a5b', '#5bc0eb', '#9bc53d', '#fde74c', '#c3423f', '#b388eb', '#f7aef8', '#72ddf7', '#ffb400', '#00a6a6'];

const SCREEN_INTERVAL_MS = 250;
/** How a refusal on a plain folder's floor starts (see Floor.plain). */
const PLAIN_FLOOR = 'This floor is a plain folder, not a git checkout';
const KEYFRAME_MS = 8000;
/** How often a steady typist's "last typed" time is refreshed for everyone. */
const TYPED_REFRESH_MS = 15_000;
const PR_TITLE_MAX = 72;
const PR_TASK_MAX = 2500;
/** The most other repositories one worker can take on (see WorkerInfo.repos). */
export const MAX_REPOS = 8;
/** Around the list of a change's pull requests in each of their descriptions, so it can be brought up to date. */
const RELATED_START = '<!-- agent-office:related -->';
const RELATED_END = '<!-- /agent-office:related -->';
/** How often every worker's folder is checked for having been deleted. */
const WATCH_MS = 10_000;
/** The most of a failed worktree setup's output its worker is told. */
const SETUP_OUTPUT_MAX = 3000;
/** How often a terminal with new output is saved to disk, so even a crash loses at most this much. */
const SAVE_SCROLLBACK_MS = 15_000;
/** Between a worker's saved scrollback and what it prints after the office restarted. */
const RESTORED_NOTE = '\x1b[2m──── the office restarted · earlier output above ────\x1b[0m\r\n';
/**
 * Sent when a Droid worker resumes a session whose active turn did not survive a restart, so it can
 * continue without another owner prompt.
 */
export const CARRY_ON_PROMPT = 'Droid Office notice: restart recovery\nYour turn was interrupted by an office restart. Continue your existing task. If waiting on an answer or permission, ask again.';

type RewindRestore = 'files' | 'conversation' | { files: readonly string[] };
type RewindResult = { ok: boolean; error?: string; note?: string; sessionId?: string };
export type DroidSetting = { setting: 'effort'; value: string } | { setting: 'model'; id?: string; name: string; effort?: string };

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface HookEnv {
  url: string;
  token: string;
}

/** Another floor's repository for a worker to work in too (see WorkerInfo.repos). */
export interface RepoSource {
  floor: string;
  /** The floor's name, for messages. */
  name: string;
  /** owner/name on the forge, when known. */
  repo?: string;
  /** Its checkout. */
  dir: string;
}

/** A pull request 'worker.pr' opened, or found already open, for a worker's branch. */
export interface OpenedPr {
  /** For a worker across repositories: which of its repositories (the folder in its workspace). */
  repo?: string;
  number: number;
  url: string;
  /** The branch already had it. */
  existed: boolean;
  /** The worktree still has uncommitted changes, which aren't in it. */
  dirty: boolean;
}

export interface WorkerEvents {
  update(info: WorkerInfo): void;
  remove(workerId: string, shot?: boolean): void;
  data(workerId: string, data: string, connectionIds: string[]): void;
  screen(workerId: string, frame: ScreenFrame): unknown;
  /** `workerId` names the worker it is about, when one is (a shot worker's dismissal). */
  toast(text: string, level: 'info' | 'warn' | 'error', workerId?: string): void;
  /** The office moved the project's checkout onto `branch` (see Worktrees.freshen). */
  checkout?(branch: string): void;
  /** A worker's tool call finished that may have changed what the office shows (see hook-refresh.ts). */
  tool?(workerId: string, refresh: ToolRefresh): void;
}

export class WorkerManager {
  private workers = new Map<string, Worker>();
  /** Which connections receive each worker's raw terminal stream (workerId -> connection IDs). */
  private subscribers = new Map<string, Set<string>>();
  /** Which connections have each worker open in a shell terminal or Thread (workerId -> connection IDs). */
  private viewers = new Map<string, Set<string>>();
  private state: WorkerStateStore;
  private trees: Worktrees;
  /** The checkout's branch when the office opened this floor (see the constructor). */
  private configuredBase?: string;
  private droidSessions = new DroidSessionReader();
  private agentPath: string | null = null;

  /** Desks and names taken by other workers (cloud workers on this floor, or live workers on other floors). */
  holds?: {
    desk(deskId: string): boolean;
    names(): Iterable<string>;
    liveDeskElsewhere?(deskId: string): { worker: WorkerInfo; floorName: string } | undefined;
    liveNamesElsewhere?(): Iterable<string>;
    allNamesElsewhere?(): Iterable<string>;
  };
  /**
   * ⚙️ Settings → Workers: a fresh worker starts from the latest of the default branch, its worktree
   * cut from origin's and the checkout brought there for one without (see freshen). Off, or unset:
   * from the branch the checkout is on, which is left alone.
   */
  freshMain?: () => boolean;
  /** ⚙️ Settings → Subagents & visits → Visits: a worker with no lead is told about the visit tools when it starts. */
  visitsOn?: () => boolean;
  /** The floor's pull requests as the board last listed them, to tell a checkout whose branch merged (see settleCheckout). */
  pullList?: () => GhPull[];
  /** Subscriptions: why an agent on this model can't start now (out of quota, say); undefined when it can (docs/subscriptions.md). */
  modelGate?: (model: string | undefined) => string | undefined;
  /** ⚙️ Settings → Subagents & visits: disable Droid's built-in Task tool in daemon sessions. Unset: disabled. */
  denyTask?: () => boolean;
  /**
   * What the office tells a worker whose turn is about to end instead of letting it stop, once: its
   * team's news, or a subagent's reminder to report (see Team.beforeStop). Only asked when its Stop can be blocked.
   */
  beforeStop?: (info: WorkerInfo) => string | undefined;
  /** Current sibling metadata for a fresh subagent brief, separate from its literal task. */
  subagentContext?: (info: WorkerInfo) => string | undefined;
  /** A turn ended and the message queued behind it starts the next one, with no rest between (see stopped). */
  nextTurn?: (info: WorkerInfo) => void;
  /** The system prompt its agents start with, in place of worker.system (the Orchestrator's brief). */
  systemPrompt?: (info: WorkerInfo) => string | undefined;
  /** Tools its agents' droid calls without Droid's permission prompt, by a PreToolUse matcher, and why. */
  /** A worker that stays asleep when the floor wakes everyone (the Orchestrator while it is off). */
  asleep?: (info: WorkerInfo) => boolean;
  /** Whether the authenticated Office MCP HTTP server is exposed to local Droid sessions on this floor. */
  officeMcpEnabled?: () => boolean;
  private settling = false;

  private get forge(): Forge {
    return this.pulls.forge ?? 'github';
  }
  /** The script a new worktree runs before its agent or shell (see worktree-setup.ts). */
  private setupScript: string | undefined;
  private screenTimer: NodeJS.Timeout;
  /** The office is shutting down: workers exiting now are being stopped, not failing to resume. */
  private closing = false;
  /** Closing for good (Ctrl+C), not restarting: whatever the workers were doing is stopped on purpose. */
  private stopping = false;
  private watchTimer: NodeJS.Timeout;
  /** Runs shell terminals outside the office, so they outlive a restart of it (see ptys.ts). */
  private host: PtyHost;
  /** Shared or manager-owned local droid-daemon client for all `kind === 'agent'` workers. */
  readonly daemon: LocalDaemon;
  private readonly ownsDaemon: boolean;
  private unsubDaemonNotif?: () => void;
  private unsubDaemonAsk?: () => void;
  private unsubDaemonLost?: () => void;
  /**
   * The boss monitor's shell, set by the floor before start(). It claims its terminal in this host
   * before unclaimed sessions are ended. A WorkerManager built on its own (tests) leaves it unset.
   */
  officeShell?: { start(): Promise<void>; shutdown(keep: boolean): void };

  /** The terminal host this floor's shells and the boss shell share. */
  get terminals(): PtyHost {
    return this.host;
  }
  /** Each shell worker's terminal on disk, so a restart doesn't wipe it (see history.ts). */
  private scrollback: ScrollbackStore;
  private drops: DropStore;
  private saveTimer: NodeJS.Timeout;
  private settings: WorkerLaunchSettings;

  constructor(
    private dir: string,
    private dataDir: string,
    private agentCmd: string,
    _agentArgs: string[],
    private hook: HookEnv,
    private events: WorkerEvents,
    /** The office's worker limit, across every floor (see machine.ts). */
    private capacity?: Capacity,
    /** Where workers' pull requests are opened: GitHub, or the floor's GitLab project. */
    private pulls: PullHost & { forge?: Forge } = githubPulls,
    /** The office's prompts and the worker a new one starts on when nobody picks, as set in Settings (see prompts.ts). */
    private prompts?: PromptSource,
    /** The floor is a plain folder, not a git checkout of its own (see Floor.plain). */
    private plain = false,
    /** The building's agents (docs/mission-control.md), who lead subagents here from no desk: `floor` is this one. */
    private building?: { agents: BuildingAgents; floor: string },
    /** Workers here have no desk: the Orchestrator's own session (see orchestrator.ts). */
    private deskless = false,
    daemon?: LocalDaemon,
  ) {
    this.trees = new Worktrees(dir, plain);
    if (!plain) this.trees.ensureBranchFile();
    // The branch the checkout was on when this floor opened: a pull request's configured base. The
    // live branch is tried after it (see open-pull.ts). Freshening the checkout does not move this.
    this.configuredBase = this.trees.currentBranch();
    this.state = new WorkerStateStore(dataDir, {
      deskless,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      color: COLORS[0],
      buildingKnown: (id) => !!this.building?.agents.known(id),
      heldDesk: (id) => !!this.holds?.desk(id),
    });
    this.settings = new WorkerLaunchSettings(dataDir, {
      systemPrompt: () => this.systemPrompt,
      visitsOn: () => this.visitsOn?.() ?? false,
      plain,
      trees: this.trees,
      prompts,
    });
    // The task queue's command, from before the queue was taken out.
    rmSync(path.join(dataDir, 'bin', 'office-queue'), { force: true });
    rmSync(path.join(dataDir, 'bin', 'office-queue.cmd'), { force: true });
    // The office-workers, office-whiteboard and office-visit commands, from before the Office MCP.
    rmSync(path.join(dataDir, 'bin', 'team'), { recursive: true, force: true });
    // Legacy PTY hook spools from pre-daemon runs.
    rmSync(path.join(dataDir, 'hook-spool'), { recursive: true, force: true });
    try {
      this.setupScript = writeSetupScript(dataDir);
    } catch {
      // without it, new worktrees just aren't set up
    }
    this.agentPath = resolveAgent(agentCmd);
    this.daemon = daemon ?? new LocalDaemon({ dataDir, agentCmd: () => this.agentPath ?? this.agentCmd });
    this.ownsDaemon = !daemon;
    this.bindDaemon();
    this.host = new PtyHost(dataDir, () => this.events.toast("The shells' terminal host stopped — restarting them", 'warn'));
    this.scrollback = new ScrollbackStore(dataDir);
    this.drops = new DropStore(dataDir);
    this.state.restore(this.workers);
    const shellIds = new Set([...this.workers.values()].filter((w) => w.info.kind === 'shell').map((w) => w.info.id));
    this.scrollback.prune(shellIds);
    // The boss shell's drops live in the same folder and are not a worker's.
    this.drops.prune(new Set([...this.workers.keys(), OFFICE_SHELL_ID]));
    for (const w of this.workers.values()) if (!w.info.activeModel) this.refreshDroidModel(w);
    this.screenTimer = setInterval(() => this.flushScreens(), SCREEN_INTERVAL_MS);
    this.watchTimer = setInterval(() => {
      for (const w of this.workers.values()) this.watchFolder(w);
    }, WATCH_MS);
    this.saveTimer = setInterval(() => {
      for (const w of this.workers.values()) if (w.info.kind === 'shell' && w.unsaved) this.saveScrollback(w);
    }, SAVE_SCROLLBACK_MS);
  }

  /**
   * Picks every shell whose terminal outlived the last office back up in `PtyHost`, and reattaches
   * every saved `agent` session in `LocalDaemon` (mid-turn or at rest). Whoever else was at a desk
   * when the office stopped gets back to work, carrying on with whatever it was in the middle of.
   */
  async start() {
    if (this.closing) return;
    const needsPtyHost = !this.deskless && (Boolean(this.officeShell) || [...this.workers.values()].some((w) => w.info.kind === 'shell'));
    if (needsPtyHost) {
      await this.host.connect();
      if (this.closing) return;
      await Promise.all(
        [...this.workers.values()].map(async (w) => {
          if (w.info.remote || w.info.kind !== 'shell') return;
          const saved = w.saved;
          w.saved = undefined;
          const adopted = saved && (await this.host.attach(saved.ptyId));
          if (adopted) {
            if (this.workers.get(w.info.id) !== w || this.closing) adopted.pty.kill();
            else this.adopt(w, adopted, saved);
          }
        }),
      );
      if (this.officeShell) await this.officeShell.start();
      this.host.killUnclaimed();
    }
    if (this.closing) return;
    // Whoever's worktree was deleted while the office was down stays asleep, marked lost, rather than failing to start.
    for (const w of this.workers.values()) this.checkLost(w);

    // Adopt saved daemon agent sessions in batch before waking any fresh/pending workers.
    const adoptCandidates = [...this.workers.values()].filter((w) => w.info.kind === 'agent' && !w.info.remote && !w.info.lost && !!w.info.sessionId && !this.asleep?.(w.info));
    if (adoptCandidates.length > 0) {
      try {
        const adopted = await this.daemon.adoptSessions(
          adoptCandidates.map((w) => ({
            sessionId: w.info.sessionId!,
            mcp: this.mcpConfig(w),
            denyTask: this.denyTask?.() ?? true,
          })),
        );
        if (!this.closing) {
          for (const w of adoptCandidates) {
            const sid = w.info.sessionId!;
            if (this.workers.get(w.info.id) !== w) continue;
            const snap = adopted.adopted.get(sid);
            const failed = adopted.failed.get(sid);
            if (failed || !snap) {
              this.daemonStartFailed(w, failed?.message ?? 'Could not reload session');
              continue;
            }
            const wasOpen = adopted.openedSessionIds.includes(sid);
            const saved = w.savedDaemon;
            w.savedDaemon = undefined;
            w.daemonActive = true;
            w.daemonLaunching = false;
            const { isBusy } = applyDaemonSnapshot(w, snap);
            const ask = this.daemon.pendingAsk(sid);
            if (ask) {
              this.onDaemonAskUser(sid, ask);
            } else if (isBusy) {
              w.interrupted = false;
              clockWork(w.info, 'working');
              this.setStatus(w, 'working');
            } else {
              const targetStatus: WorkerStatus = saved?.status === 'done' ? 'done' : 'idle';
              w.info.status = targetStatus;
              w.info.acked = targetStatus === 'done' ? (saved?.acked ?? true) : true;
              w.info.waitingSince = targetStatus === 'done' ? saved?.waitingSince : undefined;
              this.emitUpdate(w);
            }
            if (wasOpen) {
              w.interrupted = false;
              if (saved?.outbox?.length) {
                void this.sendDaemonMessage(w, officeSays(saved.outbox.join('\n\n')), undefined, false);
              }
            } else if (w.interrupted) {
              w.interrupted = false;
              const notes = [CARRY_ON_PROMPT, ...(saved?.outbox ?? [])].join('\n\n');
              void this.sendDaemonMessage(w, notes, undefined, false);
            } else if (saved?.outbox?.length) {
              void this.sendDaemonMessage(w, officeSays(saved.outbox.join('\n\n')), undefined, false);
            }
          }
          this.persist();
        }
      } catch (err) {
        for (const w of adoptCandidates) {
          if (this.workers.get(w.info.id) === w) this.daemonStartFailed(w, (err as Error).message);
        }
      }
    }

    this.wakeAll();
    void this.syncBranches();
  }

  /**
   * Fetches the branch a fresh worker starts from (the default branch, or the one the project is on;
   * see freshMain), so it starts from what's on the forge now (see Worktrees.fetch). With `checkout`,
   * for one hired into the project's checkout, which is only moved when freshMain is on. Undefined
   * when there's nothing to wait for.
   */
  fetchBase(checkout = false): Promise<void> | undefined {
    const fresh = this.freshBase();
    if (checkout && !fresh) return undefined;
    return this.trees.fetch(fresh ? 'main' : 'checkout');
  }

  private freshBase(): boolean {
    return !!this.trees.selectedBranch() || (this.freshMain?.() ?? false);
  }

  branchState() {
    return { branches: this.trees.branches(), defaultBranch: this.trees.defaultBranch(), selectedBranch: this.trees.selectedBranch() };
  }

  get baseBranch(): string | undefined {
    return this.trees.baseBranch();
  }

  get selectedBranch(): string | undefined {
    return this.trees.selectedBranch();
  }

  /** An explicit floor switch has the same no-data-loss and checkout-occupancy guards as a hire. */
  async selectBranch(branch: string | null): Promise<string | undefined> {
    if (this.selectingBranch) return 'A floor branch switch is already in progress';
    if (branch !== null && (!this.trees.validBranch(branch) || !this.trees.branches().includes(branch))) return 'Choose an existing local or origin branch';
    const target = branch ?? this.trees.defaultBranch();
    if (!target) return 'This floor has no default branch';
    this.selectingBranch = true;
    try {
      await this.trees.fetchRef(`origin/${target}`);
      const r = this.freshenWith(false, target);
      if (r.kept && r.branch !== target) return `Couldn't switch the floor to ${target}: ${r.kept}`;
      this.trees.saveBranch(branch);
      this.events.checkout?.(r.branch ?? target);
      this.events.toast(`🌿 Floor branch set to ${target}${branch === null ? ' (repository default)' : ''}${r.kept ? `: ${r.kept}` : ''}`, 'info');
      return undefined;
    } catch (err) {
      return `Couldn't switch the floor branch: ${(err as Error).message}`;
    } finally {
      this.selectingBranch = false;
    }
  }

  private selectingBranch = false;

  /**
   * Fetches what a subagent of `lead` starts from, independently of freshMain: the origin branch the
   * lead picked, or the one its own HEAD is on, so a lead sitting on an old main doesn't hand it that.
   */
  fetchStart(lead: string, from?: string): Promise<void> | undefined {
    const boss = this.get(lead) ?? this.buildingIdentity(lead);
    if (!boss) return undefined;
    const cwd = boss.worktree ? path.join(this.dir, boss.worktree.path) : this.dir;
    const where = existsSync(cwd) ? cwd : this.dir;
    if (from !== undefined) return this.trees.fetchRef(from, where);
    const branch = this.trees.resolve('HEAD', where)?.branch;
    return branch ? this.trees.refresh(branch) : undefined;
  }

  get resolvedAgent(): string | null {
    return this.agentPath;
  }

  /** Droid was installed after the floor opened (Setup): new workers run it from `file`. */
  setAgentPath(file: string) {
    this.agentPath = file;
  }

  /** What an agent starts on when whoever starts it doesn't pick, when one was set in Settings (else Droid's own default). */
  get officeDefault(): AgentChoice | undefined {
    return this.prompts?.agent();
  }

  list(): WorkerInfo[] {
    return [...this.workers.values()].map((w) => w.info);
  }

  get(id: string): WorkerInfo | undefined {
    return this.workers.get(id)?.info;
  }

  /** A building agent (the Orchestrator or an external bot): it leads subagents here from Mission Control, at no desk of this floor. */
  buildingIdentity(id: string): WorkerInfo | undefined {
    return this.workers.has(id) ? undefined : this.building?.agents.identity(id);
  }

  /** `id` is a building agent, leading now or not (the Orchestrator while it is off): what it left here stays its own. */
  buildingAgent(id: string): boolean {
    return !this.workers.has(id) && !!this.building?.agents.known(id);
  }

  /** `id` leads nobody here any more: its subagents carry on as independent workers. */
  releaseLead(id: string) {
    let changed = false;
    for (const w of this.workers.values()) {
      if (w.info.lead !== id) continue;
      delete w.info.lead;
      changed = true;
      this.emitUpdate(w);
    }
    if (changed) this.persist();
  }

  /** The folder an agent's droid runs in, where its project skills and commands come from. */
  agentFolder(id: string): string | undefined {
    const info = this.workers.get(id)?.info;
    return info?.kind === 'agent' && !info.cloud && !info.remote ? this.cwd(info) : undefined;
  }

  /** Server-owned base directory and process for terminal path links, including shell workers. */
  terminalContext(id: string): { cwd: string; pid?: number } | undefined {
    const worker = this.workers.get(id);
    if (!worker || worker.info.cloud || worker.info.remote) return undefined;
    return { cwd: this.cwd(worker.info), pid: worker.pty?.pid };
  }

  /**
   * Read-only conversation identity from worker state. Never accepts a caller-supplied path or session.
   */
  threadSession(id: string): { sessionId: string; cwd: string; drops?: string; transcript?: string } | undefined {
    const w = this.workers.get(id);
    const info = w?.info;
    if (!w || info?.kind !== 'agent' || info.cloud || !info.sessionId) return undefined;
    return { sessionId: info.sessionId, cwd: this.cwd(info), drops: this.drops.folder(id), ...(w.transcript ? { transcript: w.transcript } : {}) };
  }

  /** The local inputs of its live Thread, read when a watched conversation or daemon stream changes. */
  threadLive(id: string): ThreadLiveInputs | undefined {
    const w = this.workers.get(id);
    const info = w?.info;
    if (!w || info?.kind !== 'agent' || info.cloud || info.remote) return undefined;
    const label = w.retryState?.retrying ? w.retryState.detail : w.compacting ? 'Compacting conversation...' : undefined;
    return {
      ...(info.sessionId ? { sessionId: info.sessionId } : {}),
      status: info.status,
      ...(info.workingSince ? { workingSince: info.workingSince } : {}),
      ...(info.activity ? { activity: info.activity } : {}),
      ...(info.ask ? { ask: info.ask } : {}),
      ...(w.asking ? { asking: w.asking } : {}),
      activeTool: w.activeTool,
      daemon: {
        working: w.workingState,
        ...(w.liveStream ? { stream: w.liveStream } : {}),
        tools: [...w.liveTools.values()],
        ...(w.liveSettings ? { settings: w.liveSettings } : {}),
        ...(label ? { label } : {}),
      },
      ...(w.rewind ? { rewind: w.rewind } : {}),
    };
  }

  /** Completed thinking durations (`${messageId}:${blockIndex}` -> ms) recorded from `thinking_text_complete`. */
  thinkingDurations(id: string): ReadonlyMap<string, number> | undefined {
    const w = this.workers.get(id);
    return w?.thinkingDurations.size ? w.thinkingDurations : undefined;
  }

  /** Child subagent session links (`tool:${toolUseId}` -> `childSessionId`). */
  childSessions(id: string): ReadonlyMap<string, string> | undefined {
    const w = this.workers.get(id);
    return w?.childSessions.size ? w.childSessions : undefined;
  }

  /** Whether the worker is in a turn, so its newest Thread activity can still be working. */
  threadBusy(id: string): boolean {
    const status = this.workers.get(id)?.info.status;
    return !!status && isBusy(status);
  }

  /** The global sign writer never accepts an external path, nor writes after this manager closes. */
  labelSession(id: string): { sessionId: string; cwd: string; transcript?: string; epoch: number; since?: number } | undefined {
    if (this.closing) return;
    const w = this.workers.get(id);
    const session = this.threadSession(id);
    if (w && session) return { ...session, epoch: w.taskEpoch, since: w.info.taskSince };
  }

  localDeskOccupied(deskId: string): boolean {
    return this.ownDesk(deskId) || !!this.holds?.desk(deskId);
  }

  deskOccupied(deskId: string): boolean {
    return this.localDeskOccupied(deskId) || !!this.holds?.liveDeskElsewhere?.(deskId);
  }

  /** The seat `choose` picks for an automatic hire, avoiding desks live workers hold on other floors while another is free. */
  pickSeat(choose: (taken: (id: string) => boolean) => DeskDef | undefined): DeskDef | undefined {
    return pickUniqueSeat(choose, (id) => this.localDeskOccupied(id), this.holds?.liveDeskElsewhere ? (id) => !!this.holds?.liveDeskElsewhere?.(id) : undefined);
  }

  /** Whether one of the office's own workers sits there. */
  ownDesk(deskId: string): boolean {
    for (const w of this.workers.values()) if (w.info.deskId === deskId) return true;
    return false;
  }

  /**
   * Hires a worker at a desk. `repos` are other floors' repositories a worker in its own worktree
   * works in too (see makeWorkspace).
   * `lead` hires a subagent for that worker (see team.ts): it's told who hired it and how to report back.
   * A subagent's worktree starts where its lead is, or from `from` (a branch, tag or commit) when the
   * lead names one; nobody else's freshMain applies to it, and its checkout is never moved for it.
   */
  spawn(
    deskId: string,
    by: string,
    prompt?: string,
    worktree = false,
    kind: Exclude<WorkerKind, 'cloud'> = 'agent',
    model?: string,
    effort?: AgentEffort,
    repos: RepoSource[] = [],
    lead?: string,
    /** Pictures staged for its first prompt (see stageImage), listed after it. */
    images?: readonly string[],
    from?: string,
    branch?: string,
  ): WorkerInfo | string {
    if (this.selectingBranch) return 'Wait for the floor branch switch to finish before hiring';
    // Nobody picked a model: the office's default worker, model and effort included.
    const picked = kind === 'agent' && model === undefined ? this.officeDefault : undefined;
    if (picked) ({ model, effort } = picked);
    const modelError = validateWorkerModel(kind, model);
    if (modelError) return modelError;
    const effortError = validateWorkerEffort(kind, effort);
    if (effortError) return effortError;
    const gated = kind === 'agent' ? this.modelGate?.(model) : undefined;
    if (gated) return gated;
    const seat = DESK_BY_ID.get(deskId);
    if (!seat) return 'Unknown desk';
    // Only this floor's occupants count: a seat the office picks avoids other floors' live workers
    // before it gets here (pickSeat), while a seat someone names is theirs whatever other floors hold.
    if (this.localDeskOccupied(deskId)) return `That ${seat.beanbag ? 'bean bag' : 'desk'} is taken`;
    if (this.plain && worktree) return `${PLAIN_FLOOR}, so workers can't have worktrees`;
    if (repos.length && (kind !== 'agent' || !worktree)) return 'Only a worker in its own worktree can work in other repositories too';
    if (repos.length > MAX_REPOS) return `A worker can take on at most ${MAX_REPOS} other repositories`;
    const fresh = !this.plain && this.freshBase();
    let start: WorktreeStart = fresh ? 'main' : 'checkout';
    if (from !== undefined && (lead === undefined || !worktree)) return 'Only a subagent in its own worktree starts from a branch its lead picks';
    if (branch !== undefined && (lead === undefined || !worktree || repos.length)) return 'A named branch requires a subagent with one fresh worktree';
    if (lead !== undefined) {
      const boss = this.get(lead) ?? this.buildingIdentity(lead);
      if (!boss) return 'Its lead has left';
      if (boss.lead) return "A subagent can't hire subagents of its own";
      if (kind !== 'agent') return 'A subagent is an agent at a desk or a bean bag';
      if (worktree) {
        const at = this.leadStart(boss, from);
        if (typeof at === 'string') return at;
        start = at;
      }
    }
    const full = this.capacity?.full();
    if (full) return full;
    const sameFloorNames = [...this.workers.values()].map((w) => w.info.name).concat([...(this.holds?.names() ?? [])]);
    const name = pickUniqueWorkerName(NAMES, sameFloorNames, this.holds?.liveNamesElsewhere?.() ?? [], this.holds?.allNamesElsewhere?.() ?? []);
    const id = randomBytes(6).toString('hex');
    let wt: WorkerInfo['worktree'];
    let others: WorkerRepo[] | undefined;
    if (!worktree && fresh && kind === 'agent' && lead === undefined) this.freshenCheckout(name);
    if (worktree) {
      const slug = `${name.toLowerCase()}-${id.slice(0, 4)}`;
      const made = repos.length ? this.makeWorkspace(slug, repos, start) : this.trees.create(slug, undefined, this.dir, start, branch);
      if (typeof made === 'string') return made;
      if ('repos' in made) {
        ({ worktree: wt, repos: others } = made);
        for (const note of made.notes) this.events.toast(`🌿 ${name}'s worktree of ${note}`, 'info');
      } else {
        const { note, ...ref } = made;
        wt = ref;
        if (note) this.events.toast(`🌿 ${name}'s worktree ${note}`, 'info');
      }
    }
    const team = lead !== undefined ? this.formTeam(lead) : undefined;
    const prepared = kind === 'agent' && images?.length ? this.prepareDaemonImages(id, images) : undefined;
    const rawPrompt = prompt?.trim();
    // What the card shows when the prompt was pictures alone.
    const shown = rawPrompt || (prepared?.daemonImages.length ? 'See the attached images' : undefined);
    const info: WorkerInfo = {
      id,
      kind,
      model,
      effort,
      deskId,
      name: kind === 'shell' ? `${name} 🐚` : name,
      color: kind === 'shell' ? '#8d99ae' : COLORS[Math.floor(Math.random() * COLORS.length)],
      status: 'starting',
      acked: true,
      createdBy: by,
      createdAt: Date.now(),
      prompt: kind === 'shell' ? undefined : shown,
      worktree: wt,
      repos: others,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      open: false,
      activity: shown && kind !== 'shell' ? truncate(shown, 80) : prompt ? truncate(prompt, 80) : undefined,
      ...(lead !== undefined ? { lead } : {}),
      ...(team ? { team: memberBadge(team) } : {}),
    };
    const w = newWorker(info);
    this.notePrompt(w, shown ?? '');
    if (info.worktree) w.worktreeOwnership = Object.fromEntries(this.treesOf(info).map((t) => [t.dir, t.trees.ownership(t.ref.branch)]));
    if (wt) w.setupPlan = this.planSetup(id, wt, others);
    this.workers.set(id, w);
    const launchText = kind === 'shell' ? undefined : this.briefed(w, rawPrompt || (lead && prepared?.daemonImages.length ? 'See the attached images.' : undefined));
    this.launch(w, launchText, undefined, prepared?.daemonImages);
    this.persist();
    return info;
  }

  /** A peer with a separate conversation and, on git floors, a private repository snapshot, between turns only. */
  async fork(id: string, by: string, prompt?: string): Promise<WorkerInfo | string> {
    if (this.closing || this.selectingBranch) return 'Wait for the office to finish restarting or switching branches';
    const source = this.workers.get(id);
    if (!source) return 'No such worker';
    const modelError = this.modelGate?.(source.info.activeModel ?? source.info.model);
    if (modelError) return modelError;
    const why = forkRefusal(source.info);
    if (why) return why;
    if (source.daemonLaunching || source.compacting || source.settingUp) {
      return 'Wait for its first prompt and worktree setup to finish';
    }
    const full = this.capacity?.full();
    if (full) return full;
    const sourceDesk = DESK_BY_ID.get(source.info.deskId);
    if (!sourceDesk) return 'The source desk is no longer on this floor';
    const seat = this.pickSeat((desk) => nearestForkSeat(sourceDesk, desk));
    if (!seat) return 'Every desk and bean bag on this floor is taken';
    const sameFloorNames = [...this.workers.values()].map((w) => w.info.name).concat([...(this.holds?.names() ?? [])]);
    const name = pickUniqueForkName(source.info.name, sameFloorNames, this.holds?.liveNamesElsewhere?.() ?? [], this.holds?.allNamesElsewhere?.() ?? []);
    const twinId = randomBytes(6).toString('hex');
    const slug = `fork-${twinId}`;
    const many = !!source.info.repos?.length;
    const originals = this.plain ? [] : source.info.worktree ? this.treesOf(source.info) : [{ name: path.basename(this.dir), dir: this.dir, trees: this.trees, ref: undefined }];
    const made: { trees: Worktrees; ref: WorktreeRef }[] = [];
    let primary: WorkerInfo['worktree'];
    const others: WorkerRepo[] = [];
    try {
      for (const [i, original] of originals.entries()) {
        const cwd = original.ref?.path ? path.resolve(original.dir, original.ref.path) : original.dir;
        const wt = original.trees.fork(slug, cwd, many ? original.name : undefined, this.dir);
        if (typeof wt === 'string') throw new Error(wt);
        made.push({ trees: original.trees, ref: { ...wt, path: path.relative(original.dir, path.join(this.dir, wt.path)) } });
        if (i === 0) primary = { ...wt, from: source.info.worktree?.from ?? wt.from };
        else others.push({ ...source.info.repos![i - 1], ...wt, from: source.info.repos![i - 1].from ?? wt.from, pr: undefined });
      }
      if (many)
        this.writeBrief(
          primary!,
          others.map((r) => ({ name: r.name, project: r.repo ?? r.name, from: r.from })),
        );
    } catch (err) {
      const errors: string[] = [];
      for (const m of made.reverse()) {
        const result = await m.trees.sendHome(m.ref, 'all');
        if (result.error) errors.push(result.error);
      }
      if (many) clearWorkspace(path.join(this.dir, WORKTREES_DIR, slug));
      return `${(err as Error).message}${errors.length ? `; incomplete fork cleanup failed: ${errors.join('; ')}` : ''}`;
    }
    const text = prompt?.trim() || undefined;
    const info: WorkerInfo = {
      id: twinId,
      kind: 'agent',
      model: source.info.activeModel ?? source.info.model,
      effort: source.info.activeModel ? source.info.activeEffort : source.info.effort,
      deskId: seat.id,
      name,
      color: source.info.color,
      status: 'starting',
      acked: true,
      createdBy: by,
      createdAt: Date.now(),
      prompt: text ?? source.info.prompt,
      task: source.info.task ? { ...source.info.task } : undefined,
      worktree: primary,
      repos: many ? others : undefined,
      forkedFrom: { workerId: id, name: source.info.name, sessionId: source.info.sessionId! },
      cols: source.info.cols,
      rows: source.info.rows,
      open: false,
    };
    const w = newWorker(info);
    w.pendingFork = { sessionId: source.info.sessionId!, prompt: text };
    if (primary) {
      w.worktreeOwnership = Object.fromEntries(this.treesOf(info).map((t) => [t.dir, t.trees.ownership(t.ref.branch)]));
      w.setupPlan = this.planSetup(twinId, primary, info.repos, source.info);
    }
    this.workers.set(twinId, w);
    // Persist the fork intent before starting a session, so a restart cannot attach to the parent's session.
    this.persist();
    this.launch(w, text, undefined);
    return info;
  }

  /** The team `leadId` leads, which it starts wearing the markings of with its first hire. */
  private formTeam(leadId: string): TeamBadge | undefined {
    const lead = this.workers.get(leadId);
    if (!lead) {
      const agent = this.buildingIdentity(leadId);
      if (!agent) return undefined;
      // A building agent sits on no floor: its team here wears what its subagents here already wear, else a look new to this floor.
      const worn = [...this.workers.values()].find((w) => w.info.lead === leadId && w.info.team?.id === leadId)?.info.team;
      return worn ? { ...worn, role: 'lead' } : leadBadge(agent, this.list());
    }
    const badge = leadBadge(
      lead.info,
      [...this.workers.values()].map((w) => w.info),
    );
    if (lead.info.team !== badge) {
      lead.info.team = badge;
      this.emitUpdate(lead);
    }
    return badge;
  }

  /**
   * Where a subagent's worktree starts: `from` when its lead names it, else where the lead is (its
   * own worktree's HEAD, or the checkout's for a lead in the checkout), so what the lead has
   * committed is there. Says why not when `from` is nothing git knows.
   */
  private leadStart(lead: WorkerInfo, from: string | undefined): WorktreeStart | string {
    const cwd = lead.worktree ? path.join(this.dir, lead.worktree.path) : this.dir;
    const at = this.trees.resolve(from ?? 'HEAD', existsSync(cwd) ? cwd : this.dir);
    if (at) return from === undefined ? this.trees.caughtUp(at) : at;
    return from === undefined ? `${lead.name}'s checkout has no commit to start from` : `There's no branch, tag or commit called ${from} here`;
  }

  /**
   * A fresh worker without a worktree starts in the project's checkout: it's brought to the latest
   * of the default branch first, unless someone else is working there or it holds work that a branch
   * switch would get in the way of (see Worktrees.freshen). Toasts what happened when it's news.
   */
  private freshenCheckout(name: string) {
    const r = this.freshenWith(this.trees.delivered(this.pullList?.() ?? []));
    if (r.switchedFrom) {
      this.events.checkout?.(r.branch ?? r.main ?? '');
      this.events.toast(`🌿 Switched the checkout from ${r.switchedFrom} to ${r.main} for ${name}`, 'info');
    }
    if (r.kept) this.events.toast(`🌿 ${name} starts on ${r.branch ?? 'the checkout'} as it is, not the latest ${r.main}: ${r.kept}`, 'info');
  }

  /**
   * Worktrees.freshen with who's in the checkout sorted out: workers mid-turn block it;
   * workers at rest only block leaving a branch they may come back to, which they don't once its
   * work has landed (`delivered`).
   */
  private freshenWith(delivered: boolean, target?: string) {
    const there = [...this.workers.values()].filter((w) => this.running(w.info.id) && !w.info.worktree);
    const active = there.filter((w) => isBusy(w.info.status)).map((w) => w.info.name);
    const resting = delivered ? [] : there.filter((w) => !isBusy(w.info.status)).map((w) => w.info.name);
    return this.trees.freshen(active, resting, target);
  }

  /**
   * Puts the project's checkout back on the latest default branch once the branch it's on has merged,
   * so the next worker hired starts from there even when whoever merged it never switched back (or a
   * person merged it on the forge). Called when the pull request list comes in. Quiet when it has to
   * leave the checkout alone (it looks again with the next list), and does nothing with *Latest main*
   * off. Never touches a branch whose work hasn't landed, uncommitted changes, or a worker mid-turn.
   */
  async settleCheckout(): Promise<void> {
    if (this.settling || this.selectingBranch || !this.freshBase()) return;
    const landed = () => this.trees.delivered(this.pullList?.() ?? []);
    if (!landed()) return;
    this.settling = true;
    try {
      await this.trees.fetch('main');
      if (this.selectingBranch) return;
      if (!landed()) return;
      const r = this.freshenWith(true);
      if (!r.switchedFrom) return;
      this.events.checkout?.(r.branch ?? r.main ?? '');
      this.events.toast(`🌿 Switched the checkout from ${r.switchedFrom} to ${r.main}: its pull request merged`, 'info');
    } finally {
      this.settling = false;
    }
  }

  /**
   * The plan that makes a new worker's worktrees ready (each repository's own, across repositories),
   * written for its terminal to run; nothing when no step has anything to do.
   */
  private planSetup(id: string, wt: Worktree, others: WorkerRepo[] | undefined, source?: WorkerInfo): string | undefined {
    if (!this.setupScript) return undefined;
    try {
      const many = !!others?.length;
      const steps = [
        setupStep(source?.worktree ? path.join(this.dir, source.worktree.path) : this.dir, path.join(this.dir, wt.path), this.dataDir, many ? path.basename(wt.path) : undefined),
        ...(others ?? []).map((r, i) => setupStep(source?.repos?.[i] ? path.join(this.dir, source.repos[i].path) : r.dir, path.join(this.dir, r.path), path.join(r.dir, '.droid-office'), r.name)),
      ].filter((s): s is SetupStep => !!s);
      return steps.length ? writePlan(this.dataDir, id, steps) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Why nobody can be hired anywhere in the office right now (its worker limit), if so. */
  full(): string | undefined {
    return this.capacity?.full();
  }

  /**
   * A first prompt with what the agent is told ahead of it, for a session starting from nothing: a
   * subagent who hired it and how to report back. What shows on
   * its card is the prompt alone.
   */
  private briefed(w: Worker, prompt: string | undefined): string | undefined {
    if (!prompt) return prompt;
    const lead = w.info.lead ? (this.get(w.info.lead) ?? this.buildingIdentity(w.info.lead)) : undefined;
    if (!lead) return prompt;
    const wt = w.info.worktree;
    const where = wt
      ? `Your session starts in your own git worktree, ${path.join(this.dir, wt.path)}, on the branch ${wt.branch} made for this task from ${wt.from ?? wt.base.slice(0, 7)}.`
      : this.plain
        ? "Your session starts in the floor's folder, which isn't a git checkout and which other people and workers use too: don't undo or overwrite anyone else's files."
        : "Your session starts in the project's main checkout, which other people and workers use too: don't switch branches, stash, reset or commit in it unless your task says to.";
    const template = this.prompts?.text('subagent.brief') ?? PROMPTS['subagent.brief'].text;
    const brief = officePrompt(this.prompts, 'subagent.brief', { name: w.info.name, lead: lead.name, where, ...forgeVars(this.forge), ...workerMessageVars(prompt) });
    const taskBrief = placeholders(template).includes('text') ? brief : `${brief}\n\n${prompt}`;
    const context = this.subagentContext?.(w.info);
    return context ? `${taskBrief}\n\n${context}` : taskBrief;
  }

  /** Recent conversation / live stream lines for local Droid agents, or plain terminal tail for shells. */
  tail(id: string, lines: number): string | undefined {
    const w = this.workers.get(id);
    const info = w?.info;
    if (!w || !info) return undefined;
    if (info.remote) return `${info.name} is an external worker. No local terminal is available.\nStatus: ${info.status}\n${info.activity ?? ''}`;
    if (info.kind === 'shell') return w.term ? plainTail(w.term, lines) : undefined;
    return tailDaemonWorker(w, lines, this.sessionJsonlPath(w));
  }

  /** Keep a PR opened through Office MCP on the worker card and across restarts. */
  recordPull(id: string, pr: PullRef) {
    const w = this.workers.get(id);
    if (!w || this.closing) return;
    w.info.pr = pr;
    this.emitUpdate(w);
    this.persist();
  }

  /** The card over a worker's head, until its own sign writer has something better (a subagent's title from its lead). */
  setTask(id: string, task: WorkerTask) {
    const w = this.workers.get(id);
    if (!w || this.closing) return;
    w.info.task = {
      name: task.name.trim().slice(0, 60),
      summary: task.summary.trim().slice(0, 140),
      ...(task.generated
        ? {
            generated: true,
            ...(typeof task.textHash === 'string' && /^[a-f0-9]{64}$/.test(task.textHash) ? { textHash: task.textHash } : {}),
            ...(typeof task.updatedAt === 'number' && Number.isFinite(task.updatedAt) && task.updatedAt > 0 ? { updatedAt: task.updatedAt } : {}),
          }
        : {}),
    };
    this.emitUpdate(w);
    this.persist();
  }

  /**
   * The workspace of a worker across repositories: `.droid-office/worktrees/<slug>`, with a worktree of
   * this floor's project and of each of `repos` in it, all on office/<slug>, and a brief for the agent
   * (the 'worker.repos' prompt, as AGENTS.md). All or nothing: when one repository
   * can't have its worktree, the ones already made are taken out again.
   */
  private makeWorkspace(slug: string, repos: RepoSource[], start: WorktreeStart = 'checkout'): { worktree: NonNullable<WorkerInfo['worktree']>; repos: WorkerRepo[]; notes: string[] } | string {
    // A branch can only be checked out once per repository, and two floors can be checkouts of the same one.
    const seen = new Map<string, string>();
    const own = this.trees.commonDir();
    if (!own) return "This floor's project isn't a git checkout";
    seen.set(own, "this floor's project");
    for (const r of repos) {
      const common = new Worktrees(r.dir).commonDir();
      if (!common) return `${r.name} isn't a git checkout`;
      const twin = seen.get(common);
      if (twin) return `${r.name} is the same repository as ${twin}`;
      seen.set(common, r.name);
    }
    const names = workspaceNames([this.dir, ...repos.map((r) => r.dir)]);
    const made: { trees: Worktrees; ref: WorktreeRef }[] = [];
    const fail = (why: string) => {
      // Fresh branches with nothing on them: nothing is lost taking them out again.
      void (async () => {
        for (const m of made.reverse()) await m.trees.sendHome(m.ref, 'all');
        clearWorkspace(path.join(this.dir, WORKTREES_DIR, slug));
      })();
      return why;
    };
    const first = this.trees.create(slug, names[0], this.dir, start);
    if (typeof first === 'string') return fail(first);
    const { note, ...primary } = first;
    const notes = note ? [`${names[0]} ${note}`] : [];
    made.push({ trees: this.trees, ref: primary });
    const others: WorkerRepo[] = [];
    for (const [i, r] of repos.entries()) {
      const trees = new Worktrees(r.dir);
      // A commit names this repository's history alone: the others start from their own branch.
      const wt = trees.create(slug, names[i + 1], this.dir, typeof start === 'object' ? 'checkout' : start);
      if (typeof wt === 'string') return fail(`${r.name}: ${wt}`);
      if (wt.note) notes.push(`${names[i + 1]} ${wt.note}`);
      made.push({ trees, ref: { ...wt, path: path.relative(r.dir, path.join(this.dir, wt.path)) } });
      others.push({ floor: r.floor, name: names[i + 1], repo: r.repo, dir: r.dir, path: wt.path, branch: wt.branch, base: wt.base, from: wt.from });
    }
    try {
      this.writeBrief(
        primary,
        repos.map((r, i) => ({ name: names[i + 1], project: r.repo ?? r.name, from: others[i].from })),
      );
    } catch (err) {
      return fail(`Could not write the workspace's brief: ${(err as Error).message}`);
    }
    return { worktree: primary, repos: others, notes };
  }

  /**
   * The brief in the workspace of a worker across repositories, which folder is which project (the
   * 'worker.repos' prompt), as AGENTS.md. `primary` is its own floor's worktree, in the
   * workspace like `others`. Throws when it can't be written.
   */
  private writeBrief(primary: { path: string; branch: string; from?: string }, others: { name: string; project: string; from?: string }[]) {
    const home = originRepo(this.dir) ?? path.basename(this.dir);
    const line = (folder: string, project: string, from?: string, extra = '') => `- \`${folder}/\`: ${project}${from ? `, cut from ${from}` : ''}${extra}`;
    const brief = officePrompt(this.prompts, 'worker.repos', {
      branch: primary.branch,
      home,
      repos: [line(path.basename(primary.path), home, primary.from, " (this floor's project)"), ...others.map((o) => line(o.name, o.project, o.from))].join('\n'),
    });
    for (const file of WORKSPACE_FILES) writeFileSync(path.join(this.dir, path.dirname(primary.path), file), `${brief.trim()}\n`);
  }

  /**
   * Starts a worker that isn't running again, carrying on its session, with `prompt` as its next
   * message and any staged pictures attached.
   */
  resume(id: string, prompt?: string, images?: readonly string[]): string | undefined {
    if (this.buildingIdentity(id)) return prompt ? this.prompt(id, prompt) : 'A building agent is not started from a floor';
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    if (this.running(id)) return 'Worker is already running';
    const modelError = w.info.kind === 'agent' ? this.modelGate?.(w.info.activeModel ?? w.info.model) : undefined;
    if (modelError) return modelError;
    if (this.checkLost(w, true)) return lostMessage(w.info);
    clockWork(w.info, 'starting');
    w.info.status = 'starting';
    w.info.exitCode = undefined;
    const prepared = w.info.kind === 'agent' && images?.length ? this.prepareDaemonImages(id, images) : undefined;
    // A graceful restart can happen while initializeSession is still pending.
    // If no daemon session was recorded, the first text was never sent.
    const interruptedStart = !w.info.sessionId && w.savedDaemon?.status === 'starting' && w.info.prompt !== 'See the attached images' ? w.info.prompt : undefined;
    w.savedDaemon = undefined;
    const rawPrompt = prompt?.trim() || interruptedStart;
    // A subagent with no session to carry on starts over, so it needs telling what it's for again.
    const first = w.info.sessionId ? rawPrompt : this.briefed(w, rawPrompt || (w.info.lead && prepared?.daemonImages.length ? 'See the attached images.' : undefined));
    const shown = (rawPrompt && withoutReminders(rawPrompt)) || (prepared?.daemonImages.length ? 'See the attached images' : undefined);
    if (shown) {
      w.info.activity = truncate(shown, 80);
      this.notePrompt(w, shown);
    }
    // Cut off mid-turn by a restart: it gets on with it, as whoever was watching would have told it to.
    const carryOn = !first && !prepared?.daemonImages.length && w.interrupted && w.info.kind === 'agent' && !!w.info.sessionId;
    w.interrupted = false;
    this.launch(w, carryOn ? CARRY_ON_PROMPT : first, w.info.sessionId, prepared?.daemonImages);
    return undefined;
  }

  /**
   * Starts an agent that has no desk, under a fixed id (the Orchestrator, in its own manager). Its first
   * prompt is sent once its daemon session is ready.
   */
  spawnDeskless(id: string, name: string, color: string, by: string, prompt: string, model?: string, effort?: AgentEffort, images?: readonly string[]): WorkerInfo | string {
    if (this.closing) return 'The office is closing';
    if (this.workers.has(id)) return 'Already started';
    const modelError = validateWorkerModel('agent', model) ?? validateWorkerEffort('agent', effort) ?? this.modelGate?.(model);
    if (modelError) return modelError;
    const typed = prompt.replace(/\r\n?/g, '\n').trim();
    const prepared = images?.length ? this.prepareDaemonImages(id, images) : undefined;
    if (!typed && !prepared?.daemonImages.length) return 'Empty prompt';
    const shown = withoutReminders(typed) || 'See the attached images';
    const info: WorkerInfo = {
      id,
      kind: 'agent',
      model,
      effort,
      deskId: '',
      name,
      color,
      status: 'starting',
      acked: true,
      createdBy: by,
      createdAt: Date.now(),
      prompt: shown,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      open: false,
      activity: truncate(shown, 80),
    };
    const w = newWorker(info);
    this.notePrompt(w, shown);
    this.workers.set(id, w);
    this.launch(w, typed || undefined, undefined, prepared?.daemonImages);
    this.persist();
    return info;
  }

  /** Stops a worker's process or daemon session and keeps it, conversation and all, to resume later. */
  halt(id: string): boolean {
    const w = this.workers.get(id);
    if (!w) return false;
    if (w.info.kind === 'shell') {
      const proc = w.pty;
      if (!proc) return false;
      w.pty = undefined;
      for (const entry of w.inFlight) clearTimeout(entry.timer);
      w.inFlight.clear();
      w.activeTool.clear();
      try {
        proc.kill();
      } catch {
        // already gone
      }
    } else {
      if (!w.daemonActive) return false;
      w.daemonGeneration++;
      w.setupAbort?.abort();
      w.setupAbort = undefined;
      w.daemonActive = false;
      w.daemonLaunching = false;
      w.pendingPrompts = [];
      w.liveStream = undefined;
      w.liveTools.clear();
      w.activeTool.clear();
      w.daemonQueue = [];
      w.askState = undefined;
      w.retryState = undefined;
      w.compacting = false;
      w.workingState = 'idle';
      delete w.info.menu;
      delete w.info.queue;
      const sid = w.info.sessionId;
      if (sid) void this.daemon.closeSession(sid).catch(() => {});
    }
    clockWork(w.info, 'exited');
    w.info.status = 'exited';
    w.info.acked = true;
    w.currentTool = undefined;
    w.completedTool = undefined;
    delete w.info.ask;
    this.emitUpdate(w);
    this.persist();
    return true;
  }

  /** Stops a worker and forgets it and its conversation, but not who it leads: a new conversation for the same agent. */
  forget(id: string): boolean {
    const w = this.workers.get(id);
    if (!w) return false;
    this.workers.delete(id);
    this.subscribers.delete(id);
    this.viewers.delete(id);
    w.daemonGeneration++;
    w.setupAbort?.abort();
    w.setupAbort = undefined;
    const sid = w.daemonActive ? w.info.sessionId : undefined;
    w.daemonActive = false;
    w.daemonLaunching = false;
    w.pendingPrompts = [];
    if (sid) void this.daemon.closeSession(sid).catch(() => {});
    const proc = w.pty;
    w.pty = undefined;
    for (const entry of w.inFlight) clearTimeout(entry.timer);
    w.inFlight.clear();
    try {
      proc?.kill();
    } catch {
      // already gone
    }
    w.term?.dispose();
    if (w.info.kind === 'shell') this.scrollback.remove(id);
    this.drops.remove(id);
    this.events.remove(id);
    this.persist();
    return true;
  }

  /** The model and effort an agent runs on from its next launch; a running one updates via setting() / switchModel(). */
  choose(id: string, model: string | undefined, effort: AgentEffort | undefined): string | undefined {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    const error = validateWorkerModel('agent', model) ?? validateWorkerEffort('agent', effort);
    if (error) return error;
    w.info.model = model;
    w.info.effort = effort;
    w.info.activeModel = undefined;
    w.info.activeEffort = undefined;
    this.emitUpdate(w);
    this.persist();
    return undefined;
  }

  /** Finder reuses an ordinary worker it hired; never overwrite a running turn or AskUser. */
  async dispatchWorker(text: string, model?: string): Promise<{ info: WorkerInfo; hired: boolean } | string> {
    if (this.closing) return 'The office is closing';
    if (!text.trim()) return 'Empty prompt';
    const w = [...this.workers.values()].find((x) => x.info.createdBy === 'Finder' && x.info.kind === 'agent' && !x.info.lead && !x.info.remote);
    if (w) {
      const busy = () => isBusy(w.info.status) || w.daemonLaunching || this.settingDrives.has(w.info.id) || (w.info.lastInputAt !== undefined && Date.now() - w.info.lastInputAt < 2000);
      const busyError = 'The Finder worker is busy or waiting on input. Open its thread and try again when it is ready.';
      if (busy()) return busyError;
      const effectiveModel = model ?? w.info.activeModel ?? w.info.model;
      const invalid = validateWorkerModel('agent', effectiveModel) ?? this.modelGate?.(effectiveModel);
      if (invalid) return invalid;
      if (model && model !== (w.info.activeModel ?? w.info.model)) {
        if (this.checkLost(w, true)) return lostMessage(w.info);
        if (this.running(w.info.id) && w.info.sessionId) {
          const settingError = await this.setting(w.info.id, { setting: 'model', id: model, name: model });
          if (settingError) return settingError;
          if (this.closing || this.workers.get(w.info.id) !== w) return 'The Finder worker is no longer available';
          if (busy()) return busyError;
        } else {
          this.choose(w.info.id, model, undefined);
        }
      }
      w.info.lastInputAt = Date.now();
      const error = this.running(w.info.id) ? this.prompt(w.info.id, text) : this.resume(w.info.id, text);
      return error ?? { info: w.info, hired: false };
    }
    const seat = this.pickSeat(nextFreeSeat);
    if (!seat) return 'No free desks or bean bags for Finder dispatch';
    const info = this.spawn(seat.id, 'Finder', text, false, 'agent', model);
    if (typeof info === 'string') return info;
    info.lastInputAt = Date.now();
    return { info, hired: true };
  }

  /** Keeps a picture pasted into a prompt that isn't sent yet; its id, or undefined when it isn't a picture or couldn't be kept. */
  stageImage(name: string, body: Buffer): string | undefined {
    return this.drops.stage(name, body);
  }

  /** Throws away staged pictures: taken out of the prompt, or the prompt was never sent. */
  unstage(ids: readonly string[]) {
    this.drops.unstage(ids);
  }

  /** Connects the office-wide image store so prompts and team messages can adopt Tailnet-uploaded image ids. */
  setSharedImages(shared: SharedDropImages | undefined) {
    this.drops.setShared(shared);
  }

  /** Whether `id` names a staged or office-uploaded image this worker can adopt. */
  hasImage(id: string): boolean {
    return this.drops.hasImage(id);
  }

  /** Reads a staged or office-uploaded image's raw bytes. */
  stagedPicture(id: string): { body: Buffer; ext: string } | undefined {
    return this.drops.stagedPicture(id);
  }

  /** Whether its daemon session or shell process is running. */
  running(id: string): boolean {
    const w = this.workers.get(id);
    if (!w) return false;
    return w.info.kind === 'shell' ? !!w.pty : w.daemonActive;
  }

  /** The worker whose session holds this hook token: how a worker proves it's asking for itself. */
  authenticate(id: string, token: string): WorkerInfo | undefined {
    const w = this.workers.get(id);
    if (!w || !token || !sameToken(token, w.hookToken)) return undefined;
    return (w.info.kind === 'shell' ? !!w.pty : w.daemonActive) ? w.info : undefined;
  }

  /** Starts every worker that isn't running: nobody should be found asleep at their desk. */
  wakeAll() {
    for (const w of this.workers.values()) if (!this.running(w.info.id) && !w.info.remote && !this.asleep?.(w.info)) this.resume(w.info.id);
  }

  /** Keeps a file dropped or pasted into a worker's terminal on this machine; where it is, for the terminal to type. */
  drop(id: string, name: string, type: string, body: Buffer): string | undefined {
    return this.workers.has(id) ? this.drops.save(id, name, type, body) : undefined;
  }

  /** A picture the worker was sent with a prompt, for its Thread; undefined when it's gone or isn't one. */
  dropPicture(id: string, name: string): { body: Buffer; type: string } | undefined {
    return this.workers.has(id) ? this.drops.picture(id, name) : undefined;
  }

  /** Normal hits only open terminals in the client. A fully charged shot dismisses immediately. */
  shoot(id: string, superShot = false): string | undefined {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    if (this.closing) return 'The office is closing';
    if (!superShot) return undefined;
    void this.kill(id, undefined, undefined, undefined, true).then(
      ({ note, error }) => {
        if (note) this.events.toast(note, 'info', id);
        if (error) this.events.toast(error, 'warn', id);
      },
      (err: Error) => this.events.toast(`Couldn't dismiss ${w.info.name}: ${err.message}`, 'warn', id),
    );
    return undefined;
  }

  /** MCP's opt-in cleanup preflights before dismissing and never forces removal. */
  async dismissTeam(id: string, pruneWorktree: boolean, keepBranch: boolean): Promise<{ note?: string; error?: string }> {
    const w = this.workers.get(id);
    if (!w) return { error: 'Worker is no longer on this floor' };
    if (!pruneWorktree) return this.kill(id, 'keep');
    if (!w.info.worktree) return { error: 'Refusing to prune the main checkout; this worker has no worktree' };
    if (w.info.status === 'working' || w.info.status === 'starting' || w.info.status === 'needs_input') return { error: 'Wait for the worker to finish before pruning its worktree' };
    const trees = this.treesOf(w.info);
    for (const t of trees) {
      const abs = t.ref.path && path.resolve(t.dir, t.ref.path);
      if (!abs || !this.trees.owns(abs)) return { error: 'Refusing to prune a worktree outside the owning office' };
      const state = await t.trees.inspect(t.ref);
      if (!state.exists || state.error || state.dirty) return { error: 'Refusing to prune an unavailable or dirty worktree; commit changes or keep it' };
    }
    if (this.workers.get(id) !== w || ['working', 'starting', 'needs_input'].includes(w.info.status)) return { error: 'Worker changed during cleanup checks; read status before retrying' };
    // Stop the session before removal. Keep the existing cleanup path from ever forcing deletion.
    await this.kill(id, 'keep');
    const results = [];
    for (const t of trees) results.push(await t.trees.removeClean(t.ref, keepBranch, this.dir, w.worktreeOwnership?.[t.dir]));
    const errors = results.flatMap((r) => (r.error ? [r.error] : []));
    return errors.length ? { error: `Worker dismissed, but worktree cleanup refused: ${errors.join('; ')}` } : { note: results.map((r) => r.note).join('; ') };
  }

  /**
   * Sends a worker home. For one with its own worktree, `cleanup` says what becomes of it; with no
   * choice given, the worktree and branch go only when they hold no work, where `landed` (its merged
   * pull request's head commit) is work delivered. Resolves once that's done, with a line for the team
   * about the worktree.
   */
  async kill(id: string, cleanup?: WorktreeCleanup, landed?: string, landedRepos?: Record<string, string | undefined>, shot = false): Promise<{ note?: string; error?: string }> {
    const w = this.workers.get(id);
    if (!w) return {};
    this.workers.delete(id);
    this.subscribers.delete(id);
    this.viewers.delete(id);
    w.daemonGeneration++;
    w.setupAbort?.abort();
    w.setupAbort = undefined;
    const sid = w.daemonActive ? w.info.sessionId : undefined;
    w.daemonActive = false;
    w.daemonLaunching = false;
    w.pendingPrompts = [];
    if (sid) void this.daemon.closeSession(sid).catch(() => {});
    const proc = w.pty;
    w.pty = undefined; // so the exit handler knows this worker is gone and stays quiet
    for (const entry of w.inFlight) clearTimeout(entry.timer);
    w.inFlight.clear();
    try {
      proc?.kill();
    } catch {
      // already gone
    }
    w.term?.dispose();
    if (w.info.kind === 'shell') this.scrollback.remove(id);
    this.drops.remove(id);
    if (w.info.kind === 'agent') {
      try {
        rmSync(path.join(this.dataDir, `system-${id}.md`), { force: true });
        rmSync(path.join(this.dataDir, `droid-${id}.json`), { force: true });
      } catch {
        // ignore leftover cleanup errors
      }
    }
    this.events.remove(id, shot);
    // Its subagents stay at their desks, working for nobody now.
    for (const sub of this.workers.values()) {
      if (sub.info.lead !== id) continue;
      delete sub.info.lead;
      this.emitUpdate(sub);
    }
    this.persist();
    if (!w.info.worktree) return {};
    if (shot) return this.dismissWorktrees(w);
    // On the branch its work is on, should it have switched since it last came to rest.
    const wt = await this.current(w.info.worktree);
    const name = w.info.name;
    if (w.info.repos?.length) return this.clearRepos(w.info, cleanup, landed, landedRepos);
    if (!cleanup) {
      const work = describeWork(await this.trees.inspect(wt, landed));
      if (work) return { note: `Kept ${name}'s worktree and branch ${wt.branch} — it has ${work}` };
      cleanup = 'all';
    }
    if (cleanup === 'keep') return { note: `Kept ${name}'s worktree and branch ${wt.branch}` };
    const sent = await this.trees.sendHome(wt, cleanup);
    if (sent.error) return { error: `Couldn't delete ${name}'s worktree: ${sent.error}` };
    return { note: `Deleted ${name}'s ${sent.note}` };
  }

  private async dismissWorktrees(w: Worker): Promise<{ note?: string; error?: string }> {
    let trees: ReturnType<WorkerManager['treesOf']>;
    try {
      trees = this.treesOf(w.info);
    } catch (err) {
      return { error: `Couldn't delete ${w.info.name}'s worktrees: ${(err as Error).message}` };
    }
    const errors = (
      await Promise.all(
        trees.map(async (t) => {
          try {
            const error = await t.trees.dismiss(t.ref, this.dir, w.worktreeOwnership?.[t.dir]);
            return error && `${t.name}: ${error}`;
          } catch (err) {
            return `${t.name}: ${(err as Error).message}`;
          }
        }),
      )
    ).filter((e): e is string => !!e);
    if (errors.length) return { error: `Couldn't delete all of ${w.info.name}'s worktrees: ${errors.join('; ')}` };
    if (w.info.repos?.length) clearWorkspace(path.join(this.dir, workspaceOf(w.info)!));
    return { note: `Deleted ${w.info.name}'s worktrees and owned branches` };
  }

  /** Sending home a worker across repositories: what `kill` does with a worktree, for each of its worktrees, and then its workspace. */
  private async clearRepos(info: WorkerInfo, cleanup: WorktreeCleanup | undefined, landed?: string, landedRepos?: Record<string, string | undefined>): Promise<{ note?: string; error?: string }> {
    const trees = this.treesOf(info, landed, landedRepos);
    const { name } = info;
    const branch = info.worktree!.branch;
    const where = trees.map((t) => t.name).join(', ');
    if (!cleanup) {
      const held = (await Promise.all(trees.map(async (t) => ({ name: t.name, work: describeWork(await t.trees.inspect(t.ref, t.landed)) })))).filter((t) => t.work);
      if (held.length) return { note: `Kept ${name}'s worktrees and branch ${branch} in ${where} — ${held.map((t) => `${t.name} has ${t.work}`).join('; ')}` };
      cleanup = 'all';
    }
    if (cleanup === 'keep') return { note: `Kept ${name}'s worktrees and branch ${branch} in ${where}` };
    const sent = await Promise.all(trees.map(async (t) => ({ name: t.name, ...(await t.trees.sendHome(t.ref, cleanup)) })));
    const errors = sent.filter((t) => t.error).map((t) => `${t.name}: ${t.error}`);
    if (errors.length) return { error: `Couldn't delete all of ${name}'s worktrees: ${errors.join('; ')}` };
    clearWorkspace(path.join(this.dir, workspaceOf(info)!));
    return { note: reposHomeNote(name, branch, where, sent) };
  }

  /**
   * Each worktree a worker across repositories has, its own floor's first: its folder in the
   * workspace, git plumbing for its repository, its worktree in that repository's terms, and the
   * commit its merged pull request delivered, when known.
   */
  private treesOf(info: WorkerInfo, landed?: string, landedRepos?: Record<string, string | undefined>): { name: string; dir: string; trees: Worktrees; ref: WorktreeRef; landed?: string }[] {
    const wt = info.worktree!;
    return [
      { name: path.basename(wt.path), dir: this.dir, trees: this.trees, ref: wt, landed },
      ...(info.repos ?? []).map((r) => ({
        name: r.name,
        dir: r.dir,
        trees: new Worktrees(r.dir),
        ref: { path: path.relative(r.dir, path.join(this.dir, r.path)), branch: r.branch, base: r.base },
        landed: landedRepos?.[r.floor],
      })),
    ];
  }

  /**
   * Whether any worktree of a worker across repositories holds work its merged pull requests didn't
   * deliver (`landed` and `landedRepos`, as for kill): then it doesn't go home by itself yet.
   */
  async holdsWork(id: string, landed?: string, landedRepos?: Record<string, string | undefined>): Promise<boolean> {
    const info = this.workers.get(id)?.info;
    if (!info?.worktree) return false;
    const states = await Promise.all(this.treesOf(info, landed, landedRepos).map(async (t) => describeWork(await t.trees.inspect(t.ref, t.landed))));
    return states.some(Boolean);
  }

  /** What a worker's worktree holds, so whoever sends it home knows what deleting it would lose. */
  async inspectWorktree(id: string): Promise<WorktreeState | undefined> {
    const w = this.workers.get(id);
    const info = w?.info;
    if (!w || !info?.worktree) return undefined;
    if (!info.repos?.length) {
      await this.syncBranch(w);
      return this.trees.inspect(info.worktree);
    }
    const repos = await Promise.all(this.treesOf(info).map(async (t) => ({ name: t.name, state: await t.trees.inspect(t.ref) })));
    const sum = (k: 'dirty' | 'ahead' | 'unpushed') => repos.reduce((n, r) => n + r.state[k], 0);
    const errors = repos.filter((r) => r.state.error).map((r) => `${r.name}: ${r.state.error}`);
    return { exists: repos.every((r) => r.state.exists), dirty: sum('dirty'), ahead: sum('ahead'), unpushed: sum('unpushed'), error: errors.length ? errors.join('; ') : undefined, repos };
  }

  /** Every worker's worktree branch, looked at again (see syncBranch): for when new pull requests may have come in. */
  async syncBranches(): Promise<void> {
    if (!this.plain) {
      const live = readHeadBranch(this.dir);
      if (live.found && live.branch) this.events.checkout?.(live.branch);
    }
    await Promise.all([...this.workers.values()].map((w) => this.syncBranch(w)));
  }

  /**
   * Keeps `worktree.branch` on the branch the worktree is actually on. Agents often make their own
   * (`git checkout -b fix-x`, because the task or the repo's instructions say to) and open the pull
   * request from there, and the PR badge, O at the desk and sending it home go by it. A worker across
   * repositories keeps the branch it was given in each (see openPrs).
   */
  private async syncBranch(w: Worker): Promise<void> {
    const wt = w.info.worktree;
    if (!wt || w.info.repos?.length) return;
    const now = await this.current(wt);
    // Sent home meanwhile, or another look got there first.
    if (now === wt || this.workers.get(w.info.id) !== w || w.info.worktree !== wt) return;
    w.info.worktree = now;
    this.emitUpdate(w);
    this.persist();
  }

  /** A worktree on the branch it's on now (see Worktrees.followed); the same one when nothing moved. */
  private async current(wt: Worktree): Promise<Worktree> {
    const now = await this.trees.followed(wt);
    if (now === wt) return wt;
    return { ...wt, branch: now.branch, made: now.made };
  }

  /**
   * Whether the folder a worker works in (its worktree, or its workspace across repositories) is gone:
   * deleted outside the office. It's then marked lost (WorkerInfo.lost) for whoever comes to its desk,
   * instead of failing to start over and over; once the folder is back, it isn't any more.
   */
  private checkLost(w: Worker, recheck = false): boolean {
    const { info } = w;
    if (!info.worktree || existsSync(this.cwd(info))) {
      if (info.lost) {
        info.lost = undefined;
        this.emitUpdate(w);
      }
      return false;
    }
    // Where its branch is only changes by hand: looked at again when someone tries to start it.
    if (info.lost && !recheck) return true;
    const branch = this.trees.branchState(info.worktree.branch);
    if (branch !== info.lost?.branch) {
      info.lost = { branch };
      this.emitUpdate(w);
    }
    return true;
  }

  /**
   * Every so often: a worktree deleted under a worker marks it lost, and one put back by hand
   * (`git worktree add` at the same place) sets an asleep worker back to work.
   */
  private watchFolder(w: Worker) {
    if (!w.info.worktree || w.rebuilding) return;
    const was = !!w.info.lost;
    if (!this.checkLost(w) && was && !this.running(w.info.id)) this.resume(w.info.id);
  }

  /**
   * Puts a lost worker's worktree back where it was (see Worktrees.restore) and starts it again,
   * carrying on its conversation; across repositories, each worktree that's gone and the workspace's
   * brief.
   * Resolves to whether it `rebuilt` anything, with a note on where a branch came back from (or why
   * there was nothing to do), or to what went wrong.
   */
  async rebuild(id: string): Promise<{ rebuilt?: boolean; note?: string; error?: string }> {
    const w = this.workers.get(id);
    if (!w) return { error: 'No such worker' };
    const { info } = w;
    if (!info.worktree) return { error: `${info.name} works in the main checkout` };
    if (w.rebuilding) return {};
    const folder = this.cwd(info);
    const wasLost = !!info.lost || this.checkLost(w);
    const froms: string[] = [];
    if (!existsSync(folder)) {
      const across = !!info.repos?.length;
      w.rebuilding = true;
      try {
        for (const t of this.treesOf(info)) {
          if (t.ref.path && existsSync(path.resolve(t.dir, t.ref.path))) continue;
          const r = await t.trees.restore(t.ref);
          const which = across ? `${t.name}'s ` : '';
          if ('error' in r) return { error: `Couldn't rebuild ${info.name}'s worktree${across ? ` of ${t.name}` : ''}: ${r.error}` };
          if (r.from === 'origin') froms.push(`${which}${t.ref.branch} came back from origin`);
          if (r.from === 'gone') froms.push(`${which}${t.ref.branch} was deleted too, so it starts again from where it began`);
        }
        if (across) {
          try {
            this.writeBrief(
              info.worktree,
              info.repos!.map((r) => ({ name: r.name, project: r.repo ?? r.name, from: r.from })),
            );
          } catch {
            // The worktrees are what it needs; the brief only says which folder is which.
          }
        }
      } finally {
        w.rebuilding = false;
      }
    }
    if (wasLost && !this.checkLost(w)) this.restartIn(w);
    if (!wasLost) {
      if (!this.running(id)) this.resume(id);
      return { note: `${info.name}'s worktree is already there` };
    }
    return { rebuilt: true, note: froms.join('; ') || undefined };
  }

  /**
   * Starts a worker in its folder again: an asleep one wakes up, and one whose process or daemon session
   * was left running in the folder deleted from under it starts over in the new one, carrying on its conversation.
   */
  private restartIn(w: Worker) {
    if (w.info.kind === 'shell') {
      const proc = w.pty;
      if (proc) {
        w.pty = undefined;
        try {
          proc.kill();
        } catch {
          // already gone
        }
      }
    } else if (w.daemonActive) {
      if (midTurn(w)) w.interrupted = true;
      this.halt(w.info.id);
    }
    this.resume(w.info.id);
  }

  /** Marks one connection as viewing a worker without streaming its raw terminal (Thread view). */
  open(id: string, clientId: string): boolean {
    const w = this.workers.get(id);
    if (!w) return false;
    this.unsubscribeStream(id, clientId);
    this.addViewer(id, clientId);
    this.acknowledgeOpen(w);
    return true;
  }

  /** Alias for `open(id, clientId)` (`worker.attach` with `stream: false`). */
  viewThread(id: string, clientId: string): boolean {
    return this.open(id, clientId);
  }

  /** Subscribes one connection to a shell worker's raw terminal; daemon agents use Thread view (`open`). */
  attach(id: string, clientId: string): { data: string; cols: number; rows: number; shared: boolean } | undefined {
    const w = this.workers.get(id);
    if (w?.info.kind !== 'shell') return undefined;
    let subs = this.subscribers.get(id);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(id, subs);
    }
    const shared = [...subs].some((cid) => cid !== clientId);
    subs.add(clientId);
    this.addViewer(id, clientId);
    this.acknowledgeOpen(w);
    const data = w.snapshot ? w.snapshot() : offlineBanner(w.info);
    return { data, cols: w.info.cols, rows: w.info.rows, shared };
  }

  private addViewer(id: string, clientId: string) {
    let seen = this.viewers.get(id);
    if (!seen) {
      seen = new Set();
      this.viewers.set(id, seen);
    }
    seen.add(clientId);
  }

  private acknowledgeOpen(w: Worker) {
    let changed = this.syncOpen(w);
    if (!w.info.acked && w.info.status !== 'needs_input') {
      w.info.acked = true;
      changed = true;
    }
    if (changed) this.emitUpdate(w);
  }

  /** Lines of every worker's conversation or shell terminal holding `needle` (a searchKey), newest first, at most `perWorker` each. */
  search(needle: string, perWorker: number): { hits: TerminalHit[]; more: boolean } {
    const hits: TerminalHit[] = [];
    let more = false;
    for (const w of this.workers.values()) {
      if (w.info.remote) continue;
      if (w.info.kind === 'shell') {
        if (!w.term) continue;
        const found = searchTerminal(w.term, needle, perWorker);
        more ||= found.more;
        for (const hit of found.hits) hits.push({ workerId: w.info.id, ...hit });
      } else {
        const found = searchDaemonWorker(w, needle, perWorker, this.sessionJsonlPath(w));
        more ||= found.more;
        for (const hit of found.hits) hits.push({ workerId: w.info.id, ...hit });
      }
    }
    return { hits, more };
  }

  /** Unsubscribes one connection from a worker's terminal or Thread view. */
  detach(id: string, clientId: string) {
    const w = this.workers.get(id);
    if (!w) return;
    if (this.unsubscribe(id, clientId) && this.syncOpen(w)) this.emitUpdate(w);
  }

  /** Unsubscribes one connection from every terminal or Thread view; other connections keep theirs. */
  detachAll(clientId: string) {
    for (const w of this.workers.values()) {
      if (this.unsubscribe(w.info.id, clientId) && this.syncOpen(w)) this.emitUpdate(w);
    }
  }

  /** Removes one connection's subscription; empty entries go, so removed workers leave nothing behind. */
  private unsubscribeStream(id: string, clientId: string): boolean {
    const subs = this.subscribers.get(id);
    if (!subs?.delete(clientId)) return false;
    if (!subs.size) this.subscribers.delete(id);
    return true;
  }

  private unsubscribe(id: string, clientId: string): boolean {
    const hadStream = this.unsubscribeStream(id, clientId);
    const seen = this.viewers.get(id);
    const hadViewer = !!seen?.delete(clientId);
    if (seen && !seen.size) this.viewers.delete(id);
    return hadStream || hadViewer;
  }

  /** Interrupts the active daemon turn on `id`, if one is running. */
  interrupt(id: string): boolean {
    const w = this.workers.get(id);
    if (w?.info.kind !== 'agent') return false;
    if (w.daemonActive && w.info.sessionId && w.info.status === 'working') {
      w.cancelAt = Date.now();
      void this.daemon.interruptSession(w.info.sessionId).catch(() => {});
      return true;
    }
    return false;
  }

  /** Cancels a Droid agent's running turn via `interruptSession`. */
  cancelTurn(id: string): boolean {
    return this.interrupt(id);
  }

  /** What a Droid agent's session state shows now: busy on a turn, asking, or at rest. */
  turnScreen(id: string): 'busy' | 'asking' | 'idle' | undefined {
    const w = this.workers.get(id);
    if (w?.info.kind !== 'agent') return undefined;
    if (w.daemonActive) {
      if (w.info.status === 'needs_input') return 'asking';
      if (w.info.status === 'working') return 'busy';
      if (w.info.status === 'idle' || w.info.status === 'done') return 'idle';
      return undefined;
    }
    return undefined;
  }

  /** Keystrokes from an attached browser into a shell worker's PTY. */
  write(id: string, data: string) {
    const w = this.workers.get(id);
    if (!w?.pty) return false;
    w.pty.write(data);
    let changed = this.typed(w);
    if (w.info.status === 'needs_input' && w.info.acked === false) {
      w.info.acked = true;
      changed = true;
    }
    if (changed) this.emitUpdate(w);
    return true;
  }

  /**
   * Remembers that the terminal took input. Says whether that's news: input after a pause (not
   * every keystroke, or a typist would flood every connection with updates).
   */
  private typed(w: Worker): boolean {
    const now = Date.now();
    const last = w.info.lastInputAt;
    if (last !== undefined && now - last < TYPED_REFRESH_MS) return false;
    w.info.lastInputAt = now;
    return true;
  }

  /**
   * Submits a prompt to a worker: for `agent` workers, routes slash RPCs (`/clear`, `/new`,
   * `/compress`, `/compact`, `/handoff`) and `addUserMessage` (`EndOfTurn` steer when `!queue`,
   * `EndOfLoop` queue when `queue: true`); for `shell` workers, pastes into the shell PTY.
   */
  prompt(id: string, text: string, images?: readonly string[], queue = false): string | undefined {
    if (this.building && this.buildingIdentity(id)) {
      if (images?.length) return 'Building agents take text, not pictures, from a floor';
      return this.building.agents.tell(id, text, this.building.floor);
    }
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    if (w.info.kind === 'shell') return this.promptShell(w, text, images);
    return this.promptDaemon(w, text, images, queue);
  }

  /** Paste and submit a prompt to an explicit shell, never to a Droid session. */
  private promptShell(w: Worker, text: string, images?: readonly string[]): string | undefined {
    const pty = w.pty;
    if (!pty) return 'Worker is not running';
    const typed = text.replace(/\r\n?/g, '\n').trim();
    const clean = images?.length ? withImages(typed, this.drops.adopt(w.info.id, images)) : typed;
    if (!clean) return 'Empty prompt';
    pty.write(`\x1b[200~${clean}\x1b[201~`);
    const entry = {
      timer: setTimeout(() => {
        w.inFlight.delete(entry);
        if (w.pty === pty) pty.write('\r');
      }, 120),
    };
    w.inFlight.add(entry);
    w.info.activity = truncate(withoutReminders(typed) || 'See the attached images', 80);
    w.info.lastInputAt = Date.now();
    this.emitUpdate(w);
    return undefined;
  }

  /** Alias for `prompt`. */
  sendPrompt(id: string, text: string, images?: readonly string[], queue = false): string | undefined {
    return this.prompt(id, text, images, queue);
  }

  /** Active blocking tool call on `id` (watch command or tool running >= BLOCKING_TOOL_MS), if any. */
  blockingTool(id: string, now = Date.now()): BlockingToolState | undefined {
    const w = this.workers.get(id);
    return w ? detectBlockingTool(w.info.status, w.activeTool, now) : undefined;
  }

  /** Pending notices and Droid messages, in their delivery order. */
  queueState(id: string): WorkerQueueState | undefined {
    const w = this.workers.get(id);
    if (w?.info.kind !== 'agent' || w.info.cloud || w.info.remote) return undefined;
    return buildDaemonQueueState(w.daemonQueue, w.outbox);
  }

  /** Interrupts a running turn via `interruptSession` before delivering `text`, never answering a question. */
  async urgentPrompt(id: string, text: string, images?: readonly string[]): Promise<{ error?: string; interrupted?: boolean }> {
    if (this.building && this.buildingIdentity(id)) return { error: this.prompt(id, text, images, false) };
    const w = this.workers.get(id);
    if (!w) return { error: 'No such worker' };
    if (w.info.kind === 'shell') return { error: w.pty ? this.promptShell(w, text, images) : this.resume(id, text, images) };
    if (w.info.status === 'starting' || w.daemonLaunching) {
      return { error: `${w.info.name} is still starting up: try again in a few seconds` };
    }
    if (w.info.status === 'needs_input') {
      return { error: `${w.info.name} is waiting on an answer (${w.info.activity ?? 'a question'}): answer it first` };
    }
    if (!w.daemonActive) {
      const typed = text.replace(/\r\n?/g, '\n').trim();
      if (!typed && !images?.length) return { error: 'Empty prompt' };
      return { error: this.resume(id, typed, images) };
    }
    let interrupted = false;
    if (w.info.status === 'working' && w.info.sessionId) {
      w.cancelAt = Date.now();
      interrupted = true;
      await this.daemon.interruptSession(w.info.sessionId).catch(() => {});
      const deadline = Date.now() + 1200;
      while (Date.now() < deadline && this.workers.get(id)?.info.status === 'working' && w.daemonActive) {
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
      }
      if (this.workers.get(id)?.info.status === 'needs_input') {
        return { error: `${w.info.name} opened an interactive question while stopping; answer it before sending` };
      }
    }
    const error = this.promptDaemon(w, text, images, false);
    return { ...(error ? { error } : {}), ...(interrupted ? { interrupted: true } : {}) };
  }

  /** Rewinds before `entryId` via `getRewindInfo` + `executeRewind`, swapping the worker onto `result.newSessionId`. */
  async rewind(id: string, entryId: string, sessionId: string, restore: RewindRestore): Promise<RewindResult> {
    const w = this.workers.get(id);
    if (!w) return { ok: false, error: 'No such worker' };
    if (w.info.kind !== 'agent' || w.info.cloud || w.info.remote) return { ok: false, error: `${w.info.name} has no local conversation to rewind` };
    if (w.rewind) return { ok: false, error: `${w.info.name} is already rewinding its conversation` };
    if (w.info.status === 'working' || w.info.status === 'starting' || w.info.status === 'needs_input') {
      return { ok: false, error: `${w.info.name} is busy. Wait for its turn and any question to finish before rewinding.` };
    }
    if (w.info.sessionId !== sessionId) return { ok: false, error: `${w.info.name}'s conversation changed. Read the Thread again before rewinding.` };
    if (!w.daemonActive) return { ok: false, error: `${w.info.name} is not running` };
    if (this.settingDrives.has(id)) return { ok: false, error: `${w.info.name} is changing a setting. Try again in a moment.` };

    const parsedEntry = /^(.*):(?:text|\d+)$/.exec(entryId);
    const messageId = parsedEntry ? parsedEntry[1] : entryId;
    if (!messageId) return { ok: false, error: 'Invalid conversation entry id.' };

    w.rewind = { entryId, since: Date.now() };
    const gen = ++w.daemonGeneration;
    try {
      this.events.update(w.info);
      const rewindInfo = await this.daemon.getRewindInfo({ sessionId, messageId });
      if (this.closing || this.workers.get(id) !== w || w.daemonGeneration !== gen) {
        return { ok: false, error: `${w.info.name}'s session changed during rewind.` };
      }

      let filesToRestore = rewindInfo.availableFiles;
      let filesToDelete = rewindInfo.createdFiles;
      if (restore === 'conversation') {
        filesToRestore = [];
        filesToDelete = [];
      } else if (typeof restore === 'object' && Array.isArray(restore.files)) {
        const cwd = this.cwd(w.info);
        const wanted = new Set(restore.files.flatMap((f) => [f, path.resolve(cwd, f), f.replace(/\\/g, '/')]));
        const matchesFile = (fp: string) => {
          const rel = path.relative(cwd, fp);
          return wanted.has(fp) || wanted.has(rel) || wanted.has(rel.replace(/\\/g, '/'));
        };
        filesToRestore = rewindInfo.availableFiles.filter((f) => matchesFile(f.filePath));
        filesToDelete = rewindInfo.createdFiles.filter((f) => matchesFile(f.filePath));
      }

      const forkTitle = w.info.title || w.info.task?.name || w.info.name;
      const exec = await this.daemon.executeRewind({ sessionId, messageId, filesToRestore, filesToDelete, forkTitle });
      if (this.closing || this.workers.get(id) !== w || w.daemonGeneration !== gen) {
        return { ok: false, error: `${w.info.name}'s session changed during rewind.` };
      }

      w.info.sessionId = exec.newSessionId;
      w.transcript = undefined;
      w.messages = new CloudStreamMessages();
      w.thinkingDurations.clear();
      w.thinkingStartedAt.clear();
      w.childSessions.clear();
      w.liveStream = undefined;
      w.liveTools.clear();
      w.activeTool.clear();
      w.daemonQueue = [];
      syncWorkerQueueInfo(w);

      const snap = await this.daemon.loadSession({
        sessionId: exec.newSessionId,
        mcp: this.mcpConfig(w),
        denyTask: this.denyTask?.() ?? true,
      });
      applyDaemonSnapshot(w, snap);
      if (sessionId !== exec.newSessionId) {
        await this.daemon.closeSession(sessionId).catch(() => {});
      }
      this.persist();

      const notes: string[] = [];
      if (restore !== 'conversation') {
        if (rewindInfo.evictedFiles.length > 0) {
          notes.push(`${rewindInfo.evictedFiles.length} snapshot file${rewindInfo.evictedFiles.length === 1 ? ' was' : 's were'} evicted`);
        }
        if (exec.failedRestoreCount > 0) {
          notes.push(`${exec.failedRestoreCount} file${exec.failedRestoreCount === 1 ? '' : 's'} failed to restore`);
        }
        if (exec.failedDeleteCount > 0) {
          notes.push(`${exec.failedDeleteCount} created file${exec.failedDeleteCount === 1 ? '' : 's'} failed to delete`);
        }
      }
      return { ok: true, sessionId: exec.newSessionId, ...(notes.length ? { note: notes.join('; ') } : {}) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      w.rewind = undefined;
      if (this.workers.get(id) === w) this.emitUpdate(w);
    }
  }

  private settingDrives = new Set<string>();

  /** Changes a session's model or reasoning effort directly via `LocalDaemon.updateSessionSettings`. */
  async setting(id: string, want: DroidSetting): Promise<string | undefined> {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    if (w.info.kind !== 'agent' || w.info.cloud || w.info.remote) return `${w.info.name} has no local Droid session to change`;
    const sessionId = w.info.sessionId;
    if (!w.daemonActive || !sessionId) return `${w.info.name} is not running`;
    if (w.rewind) return `${w.info.name} is rewinding its conversation`;
    if (w.info.status === 'starting' || w.daemonLaunching) return `${w.info.name} is still starting up: try again in a few seconds`;
    if (this.settingDrives.has(id)) return `${w.info.name} is already changing a setting`;

    const generation = w.daemonGeneration;
    const current = () => !this.closing && this.workers.get(id) === w && w.daemonActive && w.daemonGeneration === generation && w.info.sessionId === sessionId;
    this.settingDrives.add(id);
    try {
      if (want.setting === 'effort') {
        if (!isAgentEffort(want.value)) return `Unsupported reasoning effort "${want.value}"`;
        await this.daemon.updateSessionSettings({ sessionId, reasoningEffort: want.value });
        if (!current()) return `${w.info.name}'s session changed before the setting could be applied`;
        w.info.effort = want.value;
        w.info.activeEffort = want.value;
        w.liveSettings = { ...w.liveSettings, reasoningEffort: want.value };
        this.emitUpdate(w);
        this.persist();
        return undefined;
      }
      const modelId = want.id || want.name;
      const effortVal = want.effort && isAgentEffort(want.effort) ? want.effort : undefined;
      if (want.effort && !effortVal) return `Unsupported reasoning effort "${want.effort}"`;
      const invalid = validateWorkerModel('agent', modelId) ?? validateWorkerEffort('agent', effortVal) ?? this.modelGate?.(modelId);
      if (invalid) return invalid;
      await this.daemon.updateSessionSettings({
        sessionId,
        modelId,
        ...(effortVal ? { reasoningEffort: effortVal } : {}),
      });
      if (!current()) return `${w.info.name}'s session changed before the setting could be applied`;
      w.info.model = modelId;
      w.info.activeModel = modelId;
      if (effortVal) {
        w.info.effort = effortVal;
        w.info.activeEffort = effortVal;
      }
      w.liveSettings = {
        ...w.liveSettings,
        model: modelId,
        ...(effortVal ? { reasoningEffort: effortVal } : {}),
      };
      this.emitUpdate(w);
      this.persist();
      return undefined;
    } catch (err) {
      return (err as Error).message;
    } finally {
      this.settingDrives.delete(id);
    }
  }

  /**
   * Moves an agent to another model via `updateSessionSettings` on a running session, or persists
   * the choice for the next launch when asleep.
   */
  async switchModel(id: string, model: { id: string; name: string }, effort?: AgentEffort): Promise<{ applied: 'now' | 'next_launch' } | { error: string }> {
    const w = this.workers.get(id);
    if (!w) return { error: 'No such worker' };
    if (w.info.kind !== 'agent' || w.info.cloud || w.info.remote) return { error: `${w.info.name} has no local Droid session to change` };
    const invalid = validateWorkerModel('agent', model.id) ?? validateWorkerEffort('agent', effort) ?? this.modelGate?.(model.id);
    if (invalid) return { error: invalid };
    if (isAsleep(w.info.status) || !w.daemonActive || !w.info.sessionId) {
      const error = this.choose(id, model.id, effort);
      return error ? { error } : { applied: 'next_launch' };
    }
    const error = await this.setting(id, { setting: 'model', id: model.id, name: model.name, ...(effort ? { effort } : {}) });
    if (error) return { error };
    return { applied: 'now' };
  }

  /** Answers the worker's pending `AskUser` question, sending `sendAskUserResponse` once the questionnaire completes. */
  answerQuestion(id: string, shownMenu: Menu, reply: AskReply): string | undefined {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    if (!w.askState || !w.info.menu || w.info.status !== 'needs_input') {
      return 'The question changed or was already answered. Your answer was not sent.';
    }
    const parsed = askAnswer(w.info.menu, shownMenu, reply);
    if ('error' in parsed) return parsed.error;

    w.askState.answers.push(parsed.answer);
    if (w.askState.answers.length < w.askState.ask.questions.length) {
      const nextQ = w.askState.ask.questions[w.askState.answers.length];
      w.info.menu = askMenu(nextQ);
      w.info.activity = truncate(nextQ.question, 80);
      w.info.lastInputAt = Date.now();
      this.emitUpdate(w);
      return undefined;
    }

    const reqId = w.askState.ask.requestId;
    const targetSessionId = w.asking?.session ?? w.info.sessionId;
    if (!targetSessionId) {
      w.askState.answers.pop();
      return 'Worker has no active session.';
    }
    const answers = w.askState.ask.questions.map((q, idx) => ({
      index: q.index,
      question: q.question,
      answer: w.askState!.answers[idx] ?? '',
    }));
    const sent = this.daemon.sendAskUserResponse(reqId, { sessionId: targetSessionId, answers });
    if (!sent) {
      w.askState.answers.pop();
      return 'Droid daemon is not connected. Try again in a moment.';
    }

    w.askState = undefined;
    w.asking = undefined;
    delete w.info.menu;
    delete w.info.ask;
    w.info.lastInputAt = Date.now();
    clockWork(w.info, 'working');
    this.setStatus(w, 'working');
    if (w.outbox.length && w.info.sessionId) {
      const held = w.outbox.splice(0);
      syncWorkerQueueInfo(w);
      void this.sendDaemonMessage(w, officeSays(held.join('\n\n')), undefined, false);
      this.persist();
    }
    return undefined;
  }

  /** Clears all pending messages, or a single item by 1-based `index` or daemon `requestId`. */
  async clearQueue(id: string, index?: number, requestId?: string): Promise<{ error?: string; cleared: QueuedMessageItem[]; remaining: WorkerQueueState }> {
    const empty: WorkerQueueState = { count: 0, items: [], moreSteering: 0, moreQueued: 0 };
    const w = this.workers.get(id);
    if (!w) return { error: 'No such worker', cleared: [], remaining: empty };
    if (w.info.kind === 'shell') return { error: `${w.info.name} is a shell: shells have no Droid message queue`, cleared: [], remaining: empty };
    if (w.info.cloud || w.info.remote) return { error: `${w.info.name} runs remotely and has no local message queue`, cleared: [], remaining: empty };

    const state = buildDaemonQueueState(w.daemonQueue, w.outbox);
    if (index !== undefined || requestId !== undefined) {
      if (!state.items.length) {
        return { error: `${w.info.name} has no queued messages to clear`, cleared: [], remaining: state };
      }
      const target = requestId ? state.items.find((it) => it.id === requestId) : state.items[index! - 1];
      if (!target) {
        return { error: requestId ? `Queued message ${requestId} is no longer in ${w.info.name}'s queue` : `No queued message #${index} on ${w.info.name} (queue has ${state.items.length})`, cleared: [], remaining: state };
      }
      if (target.source === 'outbox') {
        const outIdx = target.index - 1;
        if (outIdx >= 0 && outIdx < w.outbox.length) w.outbox.splice(outIdx, 1);
        syncWorkerQueueInfo(w);
        this.emitUpdate(w);
        this.persist();
        return { cleared: [target], remaining: buildDaemonQueueState(w.daemonQueue, w.outbox) };
      }
      if (target.id && w.info.sessionId) {
        try {
          await this.daemon.deleteQueuedMessage(w.info.sessionId, target.id);
        } catch (err) {
          return { error: (err as Error).message, cleared: [], remaining: buildDaemonQueueState(w.daemonQueue, w.outbox) };
        }
        w.daemonQueue = w.daemonQueue.filter((q) => q.requestId !== target.id);
        syncWorkerQueueInfo(w);
        this.emitUpdate(w);
      }
      return { cleared: [target], remaining: buildDaemonQueueState(w.daemonQueue, w.outbox) };
    }

    const cleared = [...state.items];
    if (w.outbox.length) {
      w.outbox = [];
    }
    if (w.info.sessionId && w.daemonQueue.length) {
      for (const entry of [...w.daemonQueue]) {
        try {
          await this.daemon.deleteQueuedMessage(w.info.sessionId, entry.requestId);
        } catch {
          // item may have already been consumed by the turn
        }
      }
    }
    w.daemonQueue = [];
    syncWorkerQueueInfo(w);
    this.emitUpdate(w);
    this.persist();
    return { cleared, remaining: buildDaemonQueueState(w.daemonQueue, w.outbox) };
  }

  /** Promotes pending message(s) on `id` forward to `EndOfTurn` steer (or interrupts and sends immediately when `urgent: true`). */
  async promoteQueue(
    id: string,
    opts: { id?: string; index?: number; all?: boolean; urgent?: boolean } = {},
  ): Promise<{
    error?: string;
    promoted: QueuedMessageItem[];
    delivery?: 'steering' | 'next_step' | 'interrupted' | 'sent' | 'already_delivered';
    stillPending?: boolean;
    remaining: WorkerQueueState;
  }> {
    const empty: WorkerQueueState = { count: 0, items: [], moreSteering: 0, moreQueued: 0 };
    const w = this.workers.get(id);
    if (!w) return { error: 'No such worker', promoted: [], stillPending: false, remaining: empty };
    if (w.info.kind === 'shell') return { error: `${w.info.name} is a shell: shells have no Droid message queue`, promoted: [], stillPending: false, remaining: empty };
    if (w.info.cloud || w.info.remote) return { error: `${w.info.name} runs remotely and has no local message queue`, promoted: [], stillPending: false, remaining: empty };

    const failWithPending = (baseError: string) => {
      const remaining = buildDaemonQueueState(w.daemonQueue, w.outbox);
      const stillPending = remaining.count > 0;
      const suffix = stillPending ? `Queue still has ${remaining.count} pending message${remaining.count === 1 ? '' : 's'}.` : 'No messages are pending in the queue.';
      return { error: `${baseError.replace(/\.$/, '')}. ${suffix}`, promoted: [], stillPending, remaining };
    };

    if (w.info.status === 'starting' || w.daemonLaunching) {
      return failWithPending(`${w.info.name} is still starting up: try again in a few seconds`);
    }
    if (w.info.status === 'needs_input') {
      return failWithPending(`${w.info.name} is waiting on an answer (${w.info.activity ?? 'a question'}): answer it first`);
    }

    const state = buildDaemonQueueState(w.daemonQueue, w.outbox);
    if (!state.items.length) return failWithPending(`${w.info.name} has no queued messages to promote`);

    let targets: QueuedMessageItem[];
    if (opts.id) {
      const picked = state.items.find((it) => it.id === opts.id);
      if (!picked) return failWithPending(`Queued message ${opts.id} is no longer in ${w.info.name}'s queue`);
      targets = [picked];
    } else if (opts.index !== undefined) {
      const picked = state.items[opts.index - 1];
      if (!picked) return failWithPending(`No queued message #${opts.index} on ${w.info.name} (queue has ${state.items.length})`);
      targets = [picked];
    } else if (opts.all) {
      targets = opts.urgent ? [...state.items] : state.items.filter((it) => it.delivery === 'after_turn' || (it.source === 'outbox' && w.info.status !== 'working'));
      if (!targets.length) targets = [...state.items];
    } else {
      const firstAfterTurn = state.items.find((it) => it.delivery === 'after_turn');
      targets = [firstAfterTurn ?? state.items[0]];
    }

    if (opts.urgent) {
      const joined = targets.map((t) => t.text).join('\n\n');
      if (!joined.trim()) return failWithPending('Empty prompt');
      const removedTexts: string[] = [];
      for (const item of [...targets].reverse()) {
        if (item.source === 'outbox') {
          const idx = w.outbox.lastIndexOf(item.text);
          if (idx >= 0) w.outbox.splice(idx, 1);
          removedTexts.push(item.text);
        } else if (item.id && w.info.sessionId) {
          try {
            await this.daemon.deleteQueuedMessage(w.info.sessionId, item.id);
            w.daemonQueue = w.daemonQueue.filter((q) => q.requestId !== item.id);
            removedTexts.push(item.text);
          } catch (err) {
            if (removedTexts.length) {
              w.outbox.push(...removedTexts.reverse());
              syncWorkerQueueInfo(w);
              this.persist();
            }
            return failWithPending((err as Error).message);
          }
        }
      }
      syncWorkerQueueInfo(w);
      const sent = await this.urgentPrompt(id, joined);
      if (sent.error) {
        w.outbox.push(...targets.map((t) => t.text));
        syncWorkerQueueInfo(w);
        this.emitUpdate(w);
        this.persist();
        return failWithPending(sent.error);
      }
      return { promoted: targets, delivery: sent.interrupted ? 'interrupted' : 'sent', stillPending: false, remaining: buildDaemonQueueState(w.daemonQueue, w.outbox) };
    }

    let delivery: 'steering' | 'next_step' | 'sent' | 'already_delivered' = 'steering';
    for (const item of targets) {
      if (item.source === 'outbox') {
        const outIdx = w.outbox.indexOf(item.text);
        if (w.info.status === 'done' || w.info.status === 'idle') {
          if (outIdx >= 0) w.outbox.splice(outIdx, 1);
          syncWorkerQueueInfo(w);
          const err = this.prompt(id, item.text, undefined, false);
          if (err) {
            w.outbox.splice(outIdx >= 0 ? outIdx : w.outbox.length, 0, item.text);
            syncWorkerQueueInfo(w);
            return failWithPending(err);
          }
          this.persist();
          delivery = 'sent';
        } else if (w.info.status === 'working' && w.info.sessionId) {
          if (outIdx >= 0) w.outbox.splice(outIdx, 1);
          syncWorkerQueueInfo(w);
          void this.sendDaemonMessage(w, officeSays(item.text), undefined, false);
          this.persist();
          delivery = 'steering';
        } else {
          delivery = 'next_step';
        }
        continue;
      }
      if (item.delivery === 'after_turn' && item.id && w.info.sessionId) {
        try {
          await this.daemon.promoteQueuedMessage(w.info.sessionId, item.id);
          const entry = w.daemonQueue.find((q) => q.requestId === item.id);
          if (entry) entry.queuePlacement = 'end_of_turn';
          syncWorkerQueueInfo(w);
          this.emitUpdate(w);
          delivery = 'steering';
        } catch (err) {
          // If the turn just ended and already drained the item, treat it as already delivered.
          if (!w.daemonQueue.some((q) => q.requestId === item.id)) {
            delivery = 'already_delivered';
            continue;
          }
          return failWithPending((err as Error).message);
        }
      }
    }
    return { promoted: targets, delivery, stillPending: false, remaining: buildDaemonQueueState(w.daemonQueue, w.outbox) };
  }

  /** Unified queue management helper (`promote`, `delete`, `clear`). */
  manageQueue(id: string, action: 'promote' | 'delete' | 'clear', opts: { id?: string; index?: number; all?: boolean; urgent?: boolean } = {}) {
    if (action === 'promote') return this.promoteQueue(id, opts);
    if (action === 'delete') return this.clearQueue(id, opts.index, opts.id);
    return this.clearQueue(id);
  }

  /**
   * Pushes a worktree worker's branch and opens a pull request (a merge request on GitLab) for it,
   * with a title and body drafted from its task. Resolves to the PR, or to a message saying why
   * there is none. The branch may already have an open PR (a second press, or one opened by hand):
   * that one is used. A worker across repositories gets one in each repository it committed to
   * (see openPrs).
   */
  async openPr(id: string, by: string): Promise<{ prs: OpenedPr[]; failed: string[] } | string> {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    const { info } = w;
    const wt = info.worktree;
    const words = forgeWords(this.forge);
    if (!wt) return `${info.name} works in the main checkout — only workers with their own worktree can open a ${words.pr}`;
    if (info.prOpening) return `${info.name}'s ${words.pull} is already being opened`;
    if (isBusy(info.status)) {
      return `${info.name} is still ${info.status === 'needs_input' ? 'waiting on input' : info.status} — wait until it's done`;
    }
    if (info.repos?.length) return this.openPrs(w, by);
    const cwd = path.join(this.dir, wt.path);
    if (!existsSync(cwd)) return `${info.name}'s worktree is gone (${wt.path})`;
    info.prOpening = true;
    this.emitUpdate(w);
    try {
      // The PR comes from the branch its work is on, which may be one it made itself.
      await this.syncBranch(w);
      const branch = info.worktree?.branch ?? wt.branch;
      const commits = (await run('git', ['log', '--reverse', '--format=%h %s', `${wt.base}..${branch}`], cwd)).split('\n').filter(Boolean);
      const dirty = await checkoutDirty(cwd);
      if (!commits.length) return dirty ? `${info.name} hasn't committed anything yet — ask it to commit first` : `${info.name} has no commits on ${branch} yet`;
      const open = await this.pulls.findOpenPull(branch, cwd);
      if (open) {
        info.pr = open;
        this.persist();
        return { prs: [{ ...open, existed: true, dirty }], failed: [] };
      }
      await pushBranch(cwd, branch, 90_000);
      const base = await choosePullBase(this.trees, branch, { from: wt.from, configured: this.trees.selectedBranch() ?? this.configuredBase, current: this.trees.currentBranch(), defaultBranch: this.trees.defaultBranch() });
      const { title, body } = draftPr(info, commits, by);
      const { number, url } = await this.pulls.createPull(cwd, branch, base, title, body);
      info.pr = { number, url };
      this.persist();
      return { prs: [{ number, url, existed: false, dirty }], failed: [] };
    } catch (err) {
      return `Couldn't open a ${words.pr} for ${info.name}: ${(err as Error).message}`;
    } finally {
      info.prOpening = false;
      // The worker may have been sent home meanwhile; an update would bring it back as a ghost.
      if (this.workers.get(id) === w) this.emitUpdate(w);
    }
  }

  /**
   * 'worker.pr' for a worker across repositories: a pull request in each repository it committed to
   * (or the one its branch already has there), with every one of them listed in each one's
   * description, so they're reviewed and merged together. The issue its task came from is closed by
   * its own floor's pull request; the others only mention it.
   */
  private async openPrs(w: Worker, by: string): Promise<{ prs: OpenedPr[]; failed: string[] } | string> {
    const { info } = w;
    const wt = info.worktree!;
    const home = originRepo(this.dir);
    const parts = [
      { name: path.basename(wt.path), dir: this.dir, path: wt.path, branch: wt.branch, base: wt.base, from: wt.from, pr: info.pr, own: true, set: (pr: { number: number; url: string }) => (info.pr = pr) },
      ...info.repos!.map((r) => ({ ...r, own: false, set: (pr: { number: number; url: string }) => (r.pr = pr) })),
    ];
    const gone = parts.filter((p) => !existsSync(path.join(this.dir, p.path)));
    if (gone.length) return `${info.name}'s worktree${gone.length > 1 ? 's' : ''} of ${gone.map((p) => p.name).join(', ')} ${gone.length > 1 ? 'are' : 'is'} gone`;
    info.prOpening = true;
    this.emitUpdate(w);
    const prs: (OpenedPr & { cwd: string })[] = [];
    const failed: string[] = [];
    const uncommitted: string[] = [];
    try {
      for (const p of parts) {
        const cwd = path.join(this.dir, p.path);
        try {
          const dirty = await checkoutDirty(cwd);
          const known = p.pr ?? (await this.pulls.findOpenPull(p.branch, cwd));
          if (known) {
            p.set(known);
            prs.push({ repo: p.name, ...known, existed: true, dirty, cwd });
            continue;
          }
          const commits = (await run('git', ['log', '--reverse', '--format=%h %s', `${p.base}..${p.branch}`], cwd)).split('\n').filter(Boolean);
          if (!commits.length) {
            if (dirty) uncommitted.push(p.name);
            continue;
          }
          await pushBranch(cwd, p.branch, 90_000);
          const repo = new Worktrees(p.dir);
          const base = await choosePullBase(repo, p.branch, { from: p.from, configured: repo.selectedBranch() ?? (p.own ? this.configuredBase : undefined), current: repo.currentBranch(), defaultBranch: repo.defaultBranch() });
          const { title, body } = draftPr(info, commits, by, p.own ? undefined : { home });
          const pr = await this.pulls.createPull(cwd, p.branch, base, title, body);
          p.set(pr);
          this.persist();
          prs.push({ repo: p.name, ...pr, existed: false, dirty, cwd });
        } catch (err) {
          failed.push(`Couldn't open a PR in ${p.name}: ${(err as Error).message}`);
        }
      }
      if (!prs.length) {
        if (failed.length) return failed.join('; ');
        return uncommitted.length ? `${info.name} hasn't committed anything yet in ${uncommitted.join(', ')} — ask it to commit first` : `${info.name} has no commits on ${wt.branch} yet in any of its repositories`;
      }
      if (prs.length > 1 && prs.some((p) => !p.existed)) {
        for (const p of prs) {
          try {
            const ref = { number: p.number, url: p.url };
            const body = this.pulls.pullBody ? await this.pulls.pullBody(ref, p.cwd) : undefined;
            if (body === undefined || !this.pulls.setPullBody) {
              failed.push(`Couldn't list the other pull requests on ${p.repo} #${p.number}: this forge can't edit a pull request's description`);
              continue;
            }
            const next = withRelated(body, relatedBlock(prs, p.url, wt.branch));
            if (next !== body) await this.pulls.setPullBody(ref, p.cwd, next);
          } catch (err) {
            failed.push(`Couldn't list the other pull requests on ${p.repo} #${p.number}: ${(err as Error).message}`);
          }
        }
      }
      this.persist();
      return { prs: prs.map(({ cwd: _cwd, ...p }) => p), failed };
    } finally {
      info.prOpening = false;
      if (this.workers.get(info.id) === w) this.emitUpdate(w);
    }
  }

  resize(id: string, cols: number, rows: number) {
    const w = this.workers.get(id);
    if (!w?.pty || !w.term) return;
    cols = clamp(Math.floor(cols), 20, 400);
    rows = clamp(Math.floor(rows), 5, 200);
    if (cols === w.info.cols && rows === w.info.rows) return;
    w.info.cols = cols;
    w.info.rows = rows;
    try {
      w.pty.resize(cols, rows);
      w.term.resize(cols, rows);
    } catch {
      // pty may have exited between checks
    }
    w.screenDirty = true;
    w.lastLines = [];
    this.emitUpdate(w);
  }

  /** Reports setup progress from the helper launched inside a shell desk's PTY. */
  shellSetupReport(id: string, token: string, payload: unknown): boolean {
    const w = this.workers.get(id);
    if (!w?.pty || w.info.kind !== 'shell' || !sameToken(token, w.hookToken) || !payload || typeof payload !== 'object') return false;
    return this.setupHook(w, payload as Record<string, unknown>);
  }

  /**
   * Hands an office notice to a worker in the middle of a turn via `addUserMessage` (`EndOfTurn` steer).
   * Returns `false` when the worker is at rest or waiting on an answer so the caller can prompt or hold instead.
   */
  notice(id: string, text: string, images?: readonly string[]): boolean {
    const w = this.workers.get(id);
    if (!w) return false;
    const typed = text.replace(/\r\n?/g, '\n').trim();
    if (w.info.kind !== 'agent' || !w.daemonActive || w.daemonLaunching || w.compacting || w.rewind || w.info.status !== 'working' || !w.info.sessionId) {
      return false;
    }
    const prepared = images?.length ? this.prepareDaemonImages(id, images) : undefined;
    if (!typed && !prepared?.daemonImages.length) return false;
    void this.sendDaemonMessage(w, typed ? officeSays(typed) : '', prepared?.daemonImages, false);
    return true;
  }

  /**
   * An office message for a worker (a visit, a lead's message, a Whiteboard ping): mid-turn it steers
   * via `notice`, otherwise it submits like a prompt (or holds while asking).
   */
  tell(id: string, text: string): string | undefined {
    const w = this.workers.get(id);
    if (w?.daemonActive && (w.info.status === 'needs_input' || w.compacting || w.rewind)) {
      return this.hold(id, text);
    }
    return this.notice(id, text) ? undefined : this.prompt(id, text);
  }

  /** Holds a notice until the worker can safely receive it, or steers immediately if mid-turn on daemon. */
  hold(id: string, text: string): string | undefined {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    if (!w.daemonActive) return 'Worker is not running';
    const clean = text.replace(/\r\n?/g, '\n').trim();
    if (!clean) return 'Empty prompt';
    if (w.info.status === 'working' && !w.daemonLaunching && !w.compacting && !w.rewind && w.info.sessionId) {
      void this.sendDaemonMessage(w, officeSays(clean), undefined, false);
      return undefined;
    }
    w.outbox.push(clean);
    syncWorkerQueueInfo(w);
    this.emitUpdate(w);
    this.persist();
    if (w.info.status === 'done' || w.info.status === 'idle') this.flushDaemonOutbox(w);
    return undefined;
  }

  /** Delivers a message immediately via `addUserMessage` when safe, or holds/resumes as needed. */
  deliverWhenSafe(id: string, text: string, images?: readonly string[]): string | undefined {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    if (!this.running(id)) return this.resume(id, text, images);
    if (w.info.status === 'needs_input' || w.compacting || w.rewind) {
      const clean = images?.length ? withImages(text.replace(/\r\n?/g, '\n').trim(), this.drops.adopt(id, images)) : text;
      return this.hold(id, clean);
    }
    if (w.info.status === 'working') {
      return this.notice(id, text, images) ? undefined : this.prompt(id, text, images, false);
    }
    return this.prompt(id, text, images, false);
  }

  /** The setup script in a new worktree's shell terminal (see worktree-setup.ts) started, or finished. */
  private setupHook(w: Worker, report: Record<string, unknown>): boolean {
    const { info } = w;
    if (!w.settingUp) return false;
    if (report.phase === 'start') {
      const commands = Array.isArray(report.commands) ? report.commands.filter((c): c is string => typeof c === 'string') : [];
      if (commands.length) info.activity = truncate(`Setting up its worktree: ${commands.join(' · ')}`, 80);
    } else if (report.phase === 'done') {
      w.settingUp = false;
      if (info.activity?.startsWith('Setting up its worktree')) info.activity = undefined;
      const failed = (Array.isArray(report.failed) ? report.failed : []).filter((f): f is { command: string; code: number; label?: string; output?: string } => !!f && typeof f.command === 'string');
      if (failed.length) {
        const what = failed.map((f) => `${f.label ? `${f.label}: ` : ''}\`${f.command}\` (exit ${f.code})`).join(', ');
        this.events.toast(`🌿 ${info.name}'s worktree setup failed: ${what}.`, 'warn', info.id);
      }
    } else return false;
    this.emitUpdate(w);
    return true;
  }

  /** Looks up the model and effort droid says a restored worker's session runs on disk. */
  private refreshDroidModel(w: Worker) {
    const { sessionId } = w.info;
    if (w.info.kind !== 'agent' || !sessionId) return;
    void this.droidSessions.read(sessionId, this.cwd(w.info), w.transcript).then((seen) => {
      if (!seen || this.workers.get(w.info.id) !== w || w.info.sessionId !== sessionId) return;
      if (seen.model === w.info.activeModel && seen.effort === w.info.activeEffort) return;
      w.info.activeModel = seen.model;
      w.info.activeEffort = seen.effort;
      this.emitUpdate(w);
    });
  }

  /** A local preview needs no inference or API key and never replaces an assigned/generated label. */
  private notePrompt(w: Worker, prompt: string) {
    if (w.info.kind !== 'agent' || w.info.task || prompt === CARRY_ON_PROMPT || !prompt.trim() || prompt.trim().startsWith('/')) return;
    w.info.task = fallbackTask(prompt);
  }

  /**
   * The office is closing. On a restart (`keep`), daemon sessions and shell terminals keep running
   * for the next office to pick back up; otherwise every worker stops.
   */
  shutdown(keep = false) {
    if (this.closing) return;
    this.closing = true;
    this.stopping = !keep;
    this.unbindDaemon();
    this.officeShell?.shutdown(keep);
    clearInterval(this.screenTimer);
    clearInterval(this.watchTimer);
    clearInterval(this.saveTimer);
    for (const w of this.workers.values()) {
      for (const entry of w.inFlight) clearTimeout(entry.timer);
      w.inFlight.clear();
      if (!keep) {
        w.setupAbort?.abort();
        w.setupAbort = undefined;
      }
      if (w.info.kind === 'shell') {
        if (w.unsaved) this.saveScrollback(w);
        if (keep && w.pty?.id) continue;
        try {
          w.pty?.kill();
        } catch {
          // ignore
        }
      }
    }
    this.persist(true);
    if (!keep) {
      for (const w of this.workers.values()) {
        w.daemonActive = false;
        w.daemonLaunching = false;
      }
    }
    if (!this.deskless) {
      if (keep) this.host.detach();
      else this.host.stop();
    }
    if (this.ownsDaemon) {
      if (keep) this.daemon.disconnect();
      else this.daemon.stop();
    }
  }

  // ---------------------------------------------------------------------------
  // Daemon session wiring (`kind === 'agent'`) & PTY shell launch (`kind === 'shell'`)
  // ---------------------------------------------------------------------------

  private bindDaemon() {
    this.unbindDaemon();
    this.unsubDaemonNotif = this.daemon.onSessionNotification((ev) => this.onDaemonNotification(ev.sessionId, ev.notification));
    this.unsubDaemonAsk = this.daemon.onAskUser((ev) => this.onDaemonAskUser(ev.sessionId, ev.ask));
    this.unsubDaemonLost = this.daemon.onConnectionLost(() => this.onDaemonConnectionLost());
  }

  private unbindDaemon() {
    this.unsubDaemonNotif?.();
    this.unsubDaemonNotif = undefined;
    this.unsubDaemonAsk?.();
    this.unsubDaemonAsk = undefined;
    this.unsubDaemonLost?.();
    this.unsubDaemonLost = undefined;
  }

  private findDaemonWorker(sessionId: string): { worker: Worker; sub: boolean } | undefined {
    for (const w of this.workers.values()) {
      if (w.info.kind !== 'agent' || !w.daemonActive) continue;
      if (w.info.sessionId === sessionId) return { worker: w, sub: false };
      if (w.subSessions.has(sessionId)) return { worker: w, sub: true };
    }
    return undefined;
  }

  private onDaemonNotification(sessionId: string, notification: unknown) {
    if (this.closing) return;
    const hit = this.findDaemonWorker(sessionId);
    if (!hit) return;
    applyDaemonNotification(hit.worker, sessionId, notification, {
      setStatus: (w, status) => this.setStatus(w, status),
      clockWork: (info, status, now) => clockWork(info, status, now),
      emitUpdate: (w) => this.emitUpdate(w),
      persist: () => this.persist(),
      syncBranch: (w) => this.syncBranch(w),
      tool: (id, refresh) => this.events.tool?.(id, refresh),
      notePrompt: (w, text) => this.notePrompt(w, text),
      setTitle: (w, title) => this.setTitle(w, title),
      beforeStop: (info) => this.beforeStop?.(info),
      nextTurn: (info) => this.nextTurn?.(info),
      sendNudge: (w, text) => {
        void this.sendDaemonMessage(w, text, undefined, false);
      },
    });
  }

  private onDaemonAskUser(sessionId: string, ask: CloudAsk | undefined) {
    if (this.closing) return;
    const hit = this.findDaemonWorker(sessionId);
    if (!hit) return;
    const { worker: w, sub } = hit;
    if (!ask) {
      if (w.asking?.session !== sessionId) return;
      w.askState = undefined;
      w.asking = undefined;
      delete w.info.menu;
      delete w.info.ask;
      if (w.info.status === 'needs_input') {
        clockWork(w.info, 'working');
        this.setStatus(w, 'working');
      } else {
        this.emitUpdate(w);
      }
      return;
    }
    w.askState = { ask, answers: [] };
    w.asking = { session: sessionId, tool: 'AskUser' };
    const questions = askedQuestions(ask);
    w.info.ask = { kind: 'question', questions, ...(sub ? { sub: true as const } : {}) };
    w.info.menu = askMenu(ask.questions[0]);
    w.info.activity = truncate(questions.length > 1 ? `${questions[0].question} (+${questions.length - 1} more)` : questions[0].question, 80);
    w.workingState = 'waiting_for_tool_confirmation';
    clockWork(w.info, 'needs_input');
    if (w.info.status === 'needs_input') {
      w.info.acked = false;
      w.info.waitingSince = Date.now();
      this.emitUpdate(w);
    } else {
      this.setStatus(w, 'needs_input');
    }
  }

  private onDaemonConnectionLost() {
    if (this.closing) return;
    const active = [...this.workers.values()].filter((w) => w.info.kind === 'agent' && w.daemonActive && !!w.info.sessionId);
    if (!active.length) return;
    void (async () => {
      try {
        const adopted = await this.daemon.adoptSessions(
          active.map((w) => ({
            sessionId: w.info.sessionId!,
            mcp: this.mcpConfig(w),
            denyTask: this.denyTask?.() ?? true,
          })),
        );
        if (this.closing) return;
        for (const w of active) {
          const sid = w.info.sessionId;
          if (!sid || this.workers.get(w.info.id) !== w || !w.daemonActive) continue;
          const snap = adopted.adopted.get(sid);
          if (!snap) continue;
          const wasOpen = adopted.openedSessionIds.includes(sid);
          const { isBusy } = applyDaemonSnapshot(w, snap);
          const ask = this.daemon.pendingAsk(sid);
          if (ask) this.onDaemonAskUser(sid, ask);
          else if (isBusy) {
            clockWork(w.info, 'working');
            this.setStatus(w, 'working');
          } else if (!wasOpen && w.info.status === 'working') {
            void this.sendDaemonMessage(w, CARRY_ON_PROMPT, undefined, false);
          }
        }
      } catch {
        // Next user interaction or reconnect attempt will re-adopt.
      }
    })();
  }

  private mcpConfig(w: Worker): OfficeMcpConnectionConfig | undefined {
    if (!this.hook.url) return undefined;
    if (!w.hookToken) w.hookToken = randomBytes(16).toString('hex');
    return {
      hookUrl: this.hook.url,
      workerHookToken: w.hookToken,
      workerId: w.info.id,
      enabled: this.officeMcpEnabled?.() ?? true,
    };
  }

  private prepareDaemonImages(id: string, images?: readonly string[]): { daemonImages: LocalImageInput[]; adoptedPaths: string[] } {
    const daemonImages: LocalImageInput[] = [];
    const adoptedPaths: string[] = [];
    for (const item of images ?? []) {
      if (!item) continue;
      if (this.drops.hasImage(item)) {
        const paths = this.drops.adopt(id, [item]);
        for (const p of paths) {
          adoptedPaths.push(p);
          const pic = this.drops.picture(id, path.basename(p));
          if (pic) {
            daemonImages.push({
              type: 'base64',
              data: pic.body.toString('base64'),
              mediaType: pic.type as LocalBase64Image['mediaType'],
            });
          } else {
            daemonImages.push(p);
          }
        }
      } else if (typeof item === 'string' && item.trim()) {
        daemonImages.push(item.trim());
      }
    }
    return { daemonImages, adoptedPaths };
  }

  private sessionJsonlPath(w: Worker): string | undefined {
    if (w.transcript) return w.transcript;
    const sid = w.info.sessionId;
    if (!sid) return undefined;
    const cwd = this.cwd(w.info);
    const slug = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
    const candidate = path.join(homedir(), '.factory', 'sessions', slug, `${sid}.jsonl`);
    return existsSync(candidate) ? candidate : undefined;
  }

  private launch(w: Worker, prompt: string | undefined, resumeSessionId: string | undefined, daemonImages?: LocalImageInput[]) {
    const { info } = w;
    // Its folder was deleted meanwhile: it waits, marked lost, for someone to rebuild it or send it home.
    if (this.checkLost(w)) {
      clockWork(info, 'exited');
      info.status = 'exited';
      this.emitUpdate(w);
      return;
    }
    if (info.kind === 'agent') {
      void this.launchDaemon(w, prompt, resumeSessionId, daemonImages);
      return;
    }

    // Shell worker (`kind === 'shell'`): spawns in `PtyHost` with `headless.Terminal` + `ScrollbackStore`.
    const restarted = !w.term;
    const before = w.term && w.ser ? terminalTail(w.term, w.ser, SCROLLBACK) : this.scrollback.load(info.id);
    const prelude = before ? `${before}\r\n${restarted ? RESTORED_NOTE : ''}` : undefined;
    const term = this.newTerm(w);
    if (prelude) {
      term.write(prelude, () => {
        if (w.term === term) w.fresh = term.registerMarker(0);
      });
    }

    const shell = defaultShell();
    const args = WIN && !process.env.SHELL ? [] : ['-l'];
    w.hookToken = randomBytes(16).toString('hex');
    for (const entry of w.inFlight) clearTimeout(entry.timer);
    w.inFlight.clear();
    w.outbox = [];
    const env = childEnv();
    Object.assign(env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      DROID_OFFICE_WORKER_ID: info.id,
      DROID_OFFICE_HOOK_URL: this.hook.url,
      DROID_OFFICE_HOOK_TOKEN: w.hookToken,
    });
    const cwd = this.cwd(info);
    if (info.repos?.length) env.GIT_CEILING_DIRECTORIES = [path.dirname(cwd), env.GIT_CEILING_DIRECTORIES].filter(Boolean).join(path.delimiter);
    else if (this.trees.ceiling) env.GIT_CEILING_DIRECTORIES = [this.trees.ceiling, env.GIT_CEILING_DIRECTORIES].filter(Boolean).join(path.delimiter);
    const where = { cwd, env, cols: info.cols, rows: info.rows, prelude };
    const plan = resumeSessionId ? undefined : w.setupPlan;
    w.setupPlan = undefined;
    let proc: Pty;
    try {
      if (plan && this.setupScript) {
        const line = setupLine({ node: process.execPath, script: this.setupScript, plan, file: shell, quoteFile: true, args, cmd: WIN && !process.env.SHELL });
        w.settingUp = true;
        proc = this.host.spawn({ file: shell, args: shellRun(line), ...where });
      } else {
        proc = this.host.spawn({ file: shell, args, ...where });
      }
    } catch (err) {
      this.startFailed(w, (err as Error).message);
      return;
    }
    info.status = 'idle';
    this.follow(w, proc, term);
    this.emitUpdate(w);
    this.persist();
  }

  private async launchDaemon(w: Worker, initialPrompt: string | undefined, resumeSessionId: string | undefined, initialImages?: LocalImageInput[]): Promise<void> {
    const { info } = w;
    const gen = ++w.daemonGeneration;
    const current = () => !this.closing && this.workers.get(info.id) === w && w.daemonGeneration === gen;
    const discardNewSession = (id: string) => {
      if (!this.closing) void this.daemon.closeSession(id).catch(() => {});
    };
    w.daemonActive = true;
    w.daemonLaunching = true;
    w.subSessions.clear();
    w.lastTool.clear();
    w.currentTool = undefined;
    w.completedTool = undefined;
    w.activeTool.clear();
    w.liveTools.clear();
    w.liveStream = undefined;
    w.retryState = undefined;
    w.askState = undefined;
    w.asking = undefined;
    w.daemonQueue = [];
    w.workingState = 'idle';
    delete info.menu;
    delete info.ask;
    delete info.queue;

    let prompt = initialPrompt;
    let setupNotice: string | undefined;
    const plan = resumeSessionId ? undefined : w.setupPlan;
    w.setupPlan = undefined;

    if (plan && this.setupScript) {
      w.settingUp = true;
      info.activity = 'Setting up its worktree...';
      this.emitUpdate(w);
      const abort = new AbortController();
      w.setupAbort = abort;
      const env = childEnv();
      const cwd = this.cwd(info);
      if (info.repos?.length) env.GIT_CEILING_DIRECTORIES = [path.dirname(cwd), env.GIT_CEILING_DIRECTORIES].filter(Boolean).join(path.delimiter);
      else if (this.trees.ceiling) env.GIT_CEILING_DIRECTORIES = [this.trees.ceiling, env.GIT_CEILING_DIRECTORIES].filter(Boolean).join(path.delimiter);

      const setupRes = await runWorktreeSetup(this.setupScript, plan, env, abort.signal);
      if (!current()) return;
      w.settingUp = false;
      w.setupAbort = undefined;
      if (info.activity?.startsWith('Setting up its worktree')) {
        info.activity = info.prompt ? truncate(info.prompt, 80) : undefined;
      }
      if (setupRes.failed.length > 0) {
        const what = setupRes.failed.map((f) => `${f.label ? `${f.label}: ` : ''}\`${f.command}\` (exit ${f.code})`).join(', ');
        const out = setupRes.failed
          .map((f) => (typeof f.output === 'string' ? f.output.slice(-SETUP_OUTPUT_MAX) : ''))
          .filter(Boolean)
          .join('\n\n');
        setupNotice = setupFailedNote(what, out);
        if (prompt) prompt = `${setupNotice}\n\n${prompt}`;
        this.events.toast(`🌿 ${info.name}'s worktree setup failed: ${what}.${prompt ? ` ${info.name}'s first message says so, with the error.` : ''}`, 'warn', info.id);
      }
      this.emitUpdate(w);
    }

    try {
      const cwd = this.cwd(info);
      const mcp = this.mcpConfig(w);
      const denyTask = this.denyTask?.() ?? true;

      if (w.pendingFork) {
        const forkSource = w.pendingFork.sessionId;
        const forkPrompt = w.pendingFork.prompt ?? prompt;
        const res = await this.daemon.forkSession({
          sessionId: forkSource,
          title: info.name,
          cwd,
          loadOptions: { mcp, denyTask },
        });
        if (!current()) return discardNewSession(res.newSessionId);
        w.pendingFork = undefined;
        info.sessionId = res.newSessionId;
        if (res.snapshot) applyDaemonSnapshot(w, res.snapshot);
        if (info.model || info.effort) {
          await this.daemon
            .updateSessionSettings({
              sessionId: res.newSessionId,
              ...(info.model ? { modelId: info.model } : {}),
              ...(info.effort ? { reasoningEffort: info.effort } : {}),
            })
            .catch(() => {});
        }
        prompt = setupNotice && forkPrompt && !forkPrompt.startsWith(setupNotice) ? `${setupNotice}\n\n${forkPrompt}` : forkPrompt;
      } else if (resumeSessionId) {
        const snap = await this.daemon.loadSession({
          sessionId: resumeSessionId,
          mcp,
          denyTask,
        });
        if (!current()) return;
        info.sessionId = resumeSessionId;
        applyDaemonSnapshot(w, snap);
        if ((info.model && info.model !== info.activeModel) || (info.effort && info.effort !== info.activeEffort)) {
          await this.daemon
            .updateSessionSettings({
              sessionId: resumeSessionId,
              ...(info.model ? { modelId: info.model } : {}),
              ...(info.effort ? { reasoningEffort: info.effort } : {}),
            })
            .catch(() => {});
        }
      } else {
        const systemPrompt = this.settings.systemPromptText(info);
        const init = await this.daemon.initializeSession({
          cwd,
          ...(info.model ? { modelId: info.model } : {}),
          ...(info.effort ? { reasoningEffort: info.effort } : {}),
          title: info.task?.name ?? info.name,
          ...(systemPrompt ? { workerSystemPrompt: systemPrompt } : {}),
          mcp,
          denyTask,
        });
        if (!current()) return discardNewSession(init.sessionId);
        info.sessionId = init.sessionId;
        applyDaemonSettings(w, init.settings);
      }

      if (!current()) return;
      w.daemonLaunching = false;
      this.persist();

      const buffered = w.pendingPrompts.splice(0);
      if (setupNotice && !prompt && buffered.length > 0) {
        buffered[0] = { ...buffered[0], text: `${setupNotice}\n\n${buffered[0].text}` };
        setupNotice = undefined;
      } else if (setupNotice && !prompt) {
        w.outbox.unshift(setupNotice);
      }

      const toSend: { text: string; images?: LocalImageInput[]; queue: boolean }[] = [];
      if (prompt || initialImages?.length) {
        toSend.push({ text: prompt ?? '', images: initialImages, queue: false });
      }
      toSend.push(...buffered);

      if (toSend.length > 0) {
        clockWork(info, 'working');
        this.setStatus(w, 'working');
        for (const msg of toSend) {
          if (!current()) return;
          await this.sendDaemonMessage(w, msg.text, msg.images, msg.queue);
        }
      } else {
        const ask = info.sessionId ? this.daemon.pendingAsk(info.sessionId) : undefined;
        if (ask && info.sessionId) {
          this.onDaemonAskUser(info.sessionId, ask);
        } else if (info.status === 'starting') {
          this.setStatus(w, 'idle');
        }
        if (w.outbox.length && (info.status === 'idle' || info.status === 'done')) {
          this.flushDaemonOutbox(w);
        }
      }
      if (current()) this.emitUpdate(w);
    } catch (err) {
      if (!current()) return;
      this.daemonStartFailed(w, (err as Error).message);
    }
  }

  private promptDaemon(w: Worker, text: string, images?: readonly string[], queue = false): string | undefined {
    if (!w.daemonActive) return 'Worker is not running';
    const typed = text.replace(/\r\n?/g, '\n').trim();
    const cmdMatch = /^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i.exec(typed);
    const slash = !images?.length && cmdMatch ? cmdMatch[1].toLowerCase() : undefined;
    const slashArg = cmdMatch?.[2]?.trim() || undefined;

    if (slash === 'quit' || slash === 'exit') {
      return 'Droid sessions stay open at their desk; use Send Home to dismiss a worker.';
    }
    if (slash === 'clear') {
      if (w.daemonLaunching || w.compacting || w.rewind) return `${w.info.name} is busy resetting or compacting; try again in a moment.`;
      void this.resetSessionConversation(w, false);
      return undefined;
    }
    if (slash === 'new') {
      if (w.daemonLaunching || w.compacting || w.rewind) return `${w.info.name} is busy resetting or compacting; try again in a moment.`;
      void this.resetSessionConversation(w, true, slashArg);
      return undefined;
    }
    if (slash === 'compress' || slash === 'compact') {
      if (!w.info.sessionId || w.daemonLaunching) return `${w.info.name} is still starting up: try again in a few seconds`;
      if (w.compacting || w.rewind) return `${w.info.name} is already compacting or rewinding its conversation`;
      if (w.info.status === 'working' || w.info.status === 'needs_input') return `Wait for ${w.info.name}'s current turn to finish before compacting.`;
      void this.compactDaemonSession(w, slashArg, false);
      return undefined;
    }
    if (slash === 'handoff') {
      if (!w.info.sessionId || w.daemonLaunching) return `${w.info.name} is still starting up: try again in a few seconds`;
      if (w.compacting || w.rewind) return `${w.info.name} is already compacting or rewinding its conversation`;
      if (w.info.status === 'working' || w.info.status === 'needs_input') return `Wait for ${w.info.name}'s current turn to finish before handing off.`;
      void this.compactDaemonSession(w, slashArg, true);
      return undefined;
    }

    const prepared = images?.length ? this.prepareDaemonImages(w.info.id, images) : undefined;
    if (!typed && !prepared?.daemonImages.length) return 'Empty prompt';

    const shown = withoutReminders(typed) || 'See the attached images';
    w.info.activity = truncate(shown, 80);
    this.notePrompt(w, shown);
    w.info.lastInputAt = Date.now();
    w.stopNudged = false;

    if (w.daemonLaunching || !w.info.sessionId) {
      w.pendingPrompts.push({ text: typed, images: prepared?.daemonImages, queue });
      this.emitUpdate(w);
      return undefined;
    }

    if (w.info.status !== 'working' && w.info.status !== 'needs_input') {
      clockWork(w.info, 'working');
      this.setStatus(w, 'working');
    } else {
      this.emitUpdate(w);
    }
    void this.sendDaemonMessage(w, typed, prepared?.daemonImages, queue);
    return undefined;
  }

  private async sendDaemonMessage(w: Worker, text: string, images: LocalImageInput[] | undefined, queue: boolean): Promise<void> {
    const sid = w.info.sessionId;
    if (!sid || !w.daemonActive) return;
    const requestId = randomUUID();
    const isWorking = w.info.status === 'working';
    const placement = queue && isWorking ? 'end_of_loop' : 'end_of_turn';
    if (isWorking) {
      w.daemonQueue.push({
        requestId,
        text,
        queuePlacement: placement,
        ...(images?.length ? { hasImage: true } : {}),
      });
      syncWorkerQueueInfo(w);
      this.emitUpdate(w);
    }
    try {
      await this.daemon.addUserMessage({
        sessionId: sid,
        text,
        images,
        queue: placement === 'end_of_loop',
        queuePlacement: placement === 'end_of_loop' ? QueuePlacement.EndOfLoop : QueuePlacement.EndOfTurn,
        requestId,
      });
    } catch (err) {
      const before = w.daemonQueue.length;
      w.daemonQueue = w.daemonQueue.filter((q) => q.requestId !== requestId);
      if (w.daemonQueue.length !== before) syncWorkerQueueInfo(w);
      if (!this.closing && this.workers.get(w.info.id) === w) {
        this.events.toast(`Could not send message to ${w.info.name}: ${(err as Error).message}`, 'warn', w.info.id);
        this.emitUpdate(w);
      }
    }
  }

  private async resetSessionConversation(w: Worker, resetModelToDefault: boolean, followUpPrompt?: string): Promise<void> {
    const { info } = w;
    const oldSessionId = info.sessionId;
    const gen = ++w.daemonGeneration;
    w.daemonLaunching = true;

    let model: string | undefined;
    let effort: AgentEffort | undefined;
    if (resetModelToDefault) {
      const def = this.officeDefault;
      model = def?.model;
      effort = def?.effort;
      info.model = model;
      info.effort = effort;
      delete info.activeModel;
      delete info.activeEffort;
      w.liveSettings = undefined;
    } else {
      model = info.activeModel ?? info.model;
      effort = info.activeEffort ?? info.effort;
    }

    w.taskEpoch++;
    info.taskSince = Date.now();
    info.task = undefined;
    delete info.todos;
    delete w.todoSteps;
    delete info.menu;
    delete info.ask;
    delete info.queue;
    w.messages = new CloudStreamMessages();
    w.screenFrame = undefined;
    w.screenDirty = true;
    w.thinkingStartedAt.clear();
    w.thinkingDurations.clear();
    w.childSessions.clear();
    w.subSessions.clear();
    w.liveStream = undefined;
    w.liveTools.clear();
    w.activeTool.clear();
    w.daemonQueue = [];
    w.askState = undefined;
    w.retryState = undefined;
    w.workingState = 'idle';
    info.activity = followUpPrompt ? truncate(withoutReminders(followUpPrompt) || followUpPrompt, 80) : undefined;
    if (followUpPrompt) this.notePrompt(w, withoutReminders(followUpPrompt) || followUpPrompt);
    clockWork(info, 'starting');
    this.setStatus(w, 'starting');

    try {
      const systemPrompt = this.settings.systemPromptText(info);
      const init = await this.daemon.initializeSession({
        cwd: this.cwd(info),
        ...(model ? { modelId: model } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
        title: info.name,
        ...(systemPrompt ? { workerSystemPrompt: systemPrompt } : {}),
        mcp: this.mcpConfig(w),
        denyTask: this.denyTask?.() ?? true,
      });
      if (this.closing || this.workers.get(info.id) !== w || w.daemonGeneration !== gen) return;
      info.sessionId = init.sessionId;
      w.transcript = undefined;
      applyDaemonSettings(w, init.settings);
      w.daemonLaunching = false;

      if (oldSessionId && oldSessionId !== init.sessionId) {
        await this.daemon.closeSession(oldSessionId).catch(() => {});
      }

      const buffered = w.pendingPrompts.splice(0);
      const toSend: { text: string; images?: LocalImageInput[]; queue: boolean }[] = [];
      if (followUpPrompt) toSend.push({ text: followUpPrompt, queue: false });
      toSend.push(...buffered);

      if (toSend.length > 0) {
        clockWork(info, 'working');
        this.setStatus(w, 'working');
        for (const m of toSend) await this.sendDaemonMessage(w, m.text, m.images, m.queue);
      } else {
        this.setStatus(w, 'idle');
      }
      this.persist();
    } catch (err) {
      if (this.closing || this.workers.get(info.id) !== w || w.daemonGeneration !== gen) return;
      this.daemonStartFailed(w, (err as Error).message);
    }
  }

  private async compactDaemonSession(w: Worker, customInstructions: string | undefined, handoff: boolean): Promise<void> {
    const { info } = w;
    const oldSessionId = info.sessionId;
    if (!oldSessionId) return;
    const gen = ++w.daemonGeneration;
    const priorStatus = info.status;
    const priorActivity = info.activity;
    w.compacting = true;
    w.workingState = 'compacting_conversation';
    info.activity = handoff ? 'Handing off its conversation...' : 'Compacting its conversation';
    info.lastInputAt = Date.now();
    clockWork(info, 'working');
    this.setStatus(w, 'working');

    try {
      const res = await this.daemon.compactSession({
        sessionId: oldSessionId,
        ...(customInstructions ? { customInstructions } : {}),
        ...(handoff ? { mode: 'handoff' as const } : {}),
      });
      if (this.closing || this.workers.get(info.id) !== w || w.daemonGeneration !== gen) return;

      if (handoff || (res.newSessionId && res.newSessionId !== oldSessionId)) {
        const nextId = res.newSessionId;
        info.sessionId = nextId;
        w.transcript = undefined;
        w.messages = new CloudStreamMessages();
        w.thinkingDurations.clear();
        w.thinkingStartedAt.clear();
        w.childSessions.clear();
        const snap = await this.daemon.loadSession({
          sessionId: nextId,
          mcp: this.mcpConfig(w),
          denyTask: this.denyTask?.() ?? true,
        });
        applyDaemonSnapshot(w, snap);
        if (oldSessionId !== nextId) {
          await this.daemon.closeSession(oldSessionId).catch(() => {});
        }
      }
      w.compacting = false;
      w.workingState = 'idle';
      info.activity = handoff ? 'Handed off conversation' : priorActivity;
      clockWork(info, 'done');
      this.setStatus(w, priorStatus === 'idle' && !handoff ? 'idle' : 'done');
      this.persist();
    } catch (err) {
      if (this.closing || this.workers.get(info.id) !== w || w.daemonGeneration !== gen) return;
      w.compacting = false;
      w.workingState = 'idle';
      info.activity = priorActivity;
      const fallbackStatus: WorkerStatus = priorStatus === 'idle' ? 'idle' : 'done';
      clockWork(info, fallbackStatus);
      this.setStatus(w, fallbackStatus);
      this.events.toast(`Could not ${handoff ? 'hand off' : 'compact'} ${info.name}'s conversation: ${(err as Error).message}`, 'warn', info.id);
    }
  }

  private flushDaemonOutbox(w: Worker) {
    if (!w.outbox.length || this.closing || this.workers.get(w.info.id) !== w || !w.daemonActive || !w.info.sessionId) return;
    if (w.info.status !== 'done' && w.info.status !== 'idle') return;
    const text = officeSays(w.outbox.splice(0).join('\n\n'));
    syncWorkerQueueInfo(w);
    clockWork(w.info, 'working');
    this.setStatus(w, 'working');
    void this.sendDaemonMessage(w, text, undefined, false);
    this.persist();
  }

  private daemonStartFailed(w: Worker, message: string) {
    const what = this.command(w.info);
    w.daemonActive = false;
    w.daemonLaunching = false;
    w.pendingPrompts = [];
    clockWork(w.info, 'exited');
    w.info.status = 'exited';
    w.info.exitCode = -1;
    w.info.activity = truncate(`Failed to start: ${message}`, 80);
    this.events.toast(`Could not start ${what}: ${message}`, 'error', w.info.id);
    this.emitUpdate(w);
    this.persist();
  }

  /** Takes back a shell terminal the host kept running while the office was down. */
  private adopt(w: Worker, adopted: Adopted, saved: NonNullable<Worker['saved']>) {
    const { info } = w;
    w.interrupted = false;
    info.cols = adopted.cols;
    info.rows = adopted.rows;
    const term = this.newTerm(w);
    term.write(adopted.snapshot, () => {
      if (w.term === term) w.fresh = term.registerMarker(0);
    });
    this.setTitle(w, adopted.title);
    if (info.status === 'offline') {
      info.status = saved.status;
      info.acked = saved.acked;
      info.waitingSince = saved.waitingSince;
    }
    this.follow(w, adopted.pty, term);
    this.emitUpdate(w);
  }

  /** A fresh screen for a shell worker's terminal, and the title off it. */
  private newTerm(w: Worker): HeadlessTerminal {
    const term = new headless.Terminal({ cols: w.info.cols, rows: w.info.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const ser = new serialize.SerializeAddon();
    term.loadAddon(ser as any);
    term.loadAddon(new unicode11.Unicode11Addon() as any);
    term.unicode.activeVersion = '11';
    term.onTitleChange((title: string) => this.setTitle(w, title));
    term.onWriteParsed(() => {
      w.screenDirty = true;
    });
    w.term?.dispose();
    w.term = term;
    w.ser = ser;
    w.snapshot = screenSnapshot(term, ser);
    w.lastLines = [];
    w.screenDirty = true;
    w.needsKeyframe = false;
    w.fresh = undefined;
    return term;
  }

  private setTitle(w: Worker, title: string) {
    const clean = title.replace(/^[^\p{L}\p{N}]+/u, '').trim();
    if (clean && clean !== w.info.title && !/^droid$/i.test(clean) && !/^new session$/i.test(clean)) {
      w.info.title = clean;
      this.emitUpdate(w);
    }
  }

  /** Shows a shell worker's terminal output as it comes, and deals with the process ending. */
  private follow(w: Worker, proc: Pty, term: HeadlessTerminal) {
    const { info } = w;
    w.pty = proc;
    if (!proc.id) {
      setTerminalResponder(term, (reply) => {
        if (w.pty === proc) proc.write(reply);
      });
    }
    proc.onData((data) => {
      term.write(data);
      w.outputAt = Date.now();
      w.screenDirty = true;
      w.unsaved = true;
      const targets = this.subscriberIds(info.id);
      if (targets.length) this.events.data(info.id, data, targets);
    });
    proc.onExit(({ exitCode, error, lost }) => {
      if (w.pty !== proc || this.workers.get(info.id) !== w) return;
      w.pty = undefined;
      if (error) {
        this.startFailed(w, error);
        return;
      }
      if (lost && !this.closing) {
        if (midTurn(w)) w.interrupted = true;
        this.resume(info.id);
        return;
      }
      info.exitCode = exitCode;
      info.status = 'exited';
      const hint = info.kind === 'shell' ? ' — press R to restart' : info.sessionId ? ' — press R to resume' : '';
      const msg = `\r\n\x1b[2m[${info.name} exited with code ${exitCode}${hint}]\x1b[0m\r\n`;
      term.write(msg);
      const targets = this.subscriberIds(info.id);
      if (targets.length) this.events.data(info.id, msg, targets);
      w.screenDirty = true;
      w.unsaved = true;
      this.emitUpdate(w);
      this.persist();
      void this.syncBranch(w);
    });
  }

  private startFailed(w: Worker, message: string) {
    const what = this.command(w.info);
    const msg = `\r\n\x1b[31mFailed to start ${what}: ${message}\x1b[0m\r\n`;
    w.info.status = 'exited';
    w.info.exitCode = -1;
    w.term?.write(msg);
    const targets = this.subscriberIds(w.info.id);
    if (targets.length) this.events.data(w.info.id, msg, targets);
    w.screenDirty = true;
    w.unsaved = true;
    this.events.toast(`Could not start ${what}: ${message}`, 'error');
    this.emitUpdate(w);
  }

  /** What a worker runs: the shell, or the configured Droid command. */
  private command(info: WorkerInfo): string {
    return info.kind === 'shell' ? defaultShell() : this.agentCmd;
  }

  /** Where a worker works: its worktree, a workspace for a worker across repositories, or the project itself. */
  private cwd(info: WorkerInfo): string {
    const rel = workspaceOf(info);
    return rel ? path.join(this.dir, rel) : this.dir;
  }

  private setStatus(w: Worker, status: WorkerStatus) {
    if (w.info.status === status) return;
    w.info.status = status;
    if (status !== 'working') w.currentTool = undefined;
    if (status !== 'needs_input') {
      w.asking = undefined;
      w.askState = undefined;
      delete w.info.ask;
      delete w.info.menu;
    }
    // Done, idle or asleep: it's not acting anything out any more.
    if (status !== 'working' && status !== 'needs_input') {
      w.info.action = undefined;
      w.activeTool.clear();
      w.liveTools.clear();
      w.liveStream = undefined;
      w.daemonQueue = [];
      syncWorkerQueueInfo(w);
    }
    // A finished list stays up for the turn that finished it, not after.
    if ((status === 'done' || status === 'idle') && w.info.todos && todosFinished(w.info.todos)) {
      delete w.info.todos;
      delete w.todoSteps;
    }
    // Nobody is looking at the Thread/terminal right now -> raise the flag (the worker jumps).
    if (status === 'done' || status === 'needs_input') {
      w.info.acked = status === 'done' && w.info.open;
      w.info.waitingSince = Date.now();
    } else w.info.acked = true;
    this.emitUpdate(w);
    if (w.pty?.id || w.daemonActive) this.persist();
    // At rest: it may have made a branch of its own this turn, and opened its PR from there.
    if (status === 'done' || status === 'idle') {
      void this.syncBranch(w);
      if (w.daemonActive && w.outbox.length) this.flushDaemonOutbox(w);
    }
  }

  /** The connections subscribed to a worker's terminal, oldest first. */
  private subscriberIds(id: string): string[] {
    return [...(this.subscribers.get(id) ?? [])];
  }

  /** Syncs the public open flag with the open viewers; says whether it changed. */
  private syncOpen(w: Worker): boolean {
    const open = (this.viewers.get(w.info.id)?.size ?? 0) > 0;
    if (w.info.open === open) return false;
    w.info.open = open;
    return true;
  }

  private emitUpdate(w: Worker) {
    this.events.update({ ...w.info });
  }

  /** Structured runtime telemetry for MCP worker inspection without modifying terminal state. */
  runtime(id: string): (WorkerRuntimeSnapshot & { retry?: WorkerRetryStatus; menu?: Menu }) | undefined {
    const w = this.workers.get(id);
    if (!w) return undefined;
    const rows = w.term ? screenRows(w.term) : undefined;
    const queuedMessages = w.daemonQueue.length ? w.daemonQueue.map((q) => q.text) : undefined;
    return {
      ...(w.todoSteps?.length ? { todoSteps: w.todoSteps.map((s) => ({ ...s })) } : {}),
      ...(w.currentTool ? { currentTool: { ...w.currentTool } } : {}),
      ...(w.completedTool ? { lastTool: { ...w.completedTool } } : {}),
      ...(w.hookAt > 0 ? { lastHookAt: w.hookAt } : {}),
      ...(w.outputAt > 0 ? { lastOutputAt: w.outputAt } : {}),
      ...(queuedMessages ? { queuedMessages } : {}),
      ...(w.outbox.length > 0 ? { queuedNotices: w.outbox.length } : {}),
      ...(rows ? { screenRows: rows.slice(-20) } : {}),
      ...(w.retryState ? { retry: { ...w.retryState } } : {}),
      ...(w.info.menu ? { menu: w.info.menu } : {}),
    };
  }

  /** Alias for `runtime(id)`. */
  runtimeSnapshot(id: string) {
    return this.runtime(id);
  }

  private computeDaemonScreen(w: Worker): ScreenFrame | undefined {
    const recent = w.messages.values().slice(-20);
    if (!recent.length) return w.screenFrame;
    const rendered = cloudScreen(recent);
    if (!rendered) return w.screenFrame;
    const frame: ScreenFrame = { ...rendered, full: true };
    w.screenFrame = frame;
    return frame;
  }

  /** Full screen for one running worker, e.g. when a cross-floor worker needs input. */
  fullScreen(id: string): ScreenFrame | undefined {
    const w = this.workers.get(id);
    if (!w) return undefined;
    if (w.term) return snapshotScreen(w.term, []) || undefined;
    return w.screenFrame ?? this.computeDaemonScreen(w);
  }

  /** Full screens for every running worker — sent to people as they walk in. */
  fullScreens() {
    const out: { workerId: string; frame: ScreenFrame }[] = [];
    for (const w of this.workers.values()) {
      if (w.term) {
        const frame = snapshotScreen(w.term, []);
        if (frame) out.push({ workerId: w.info.id, frame });
      } else if (w.info.kind === 'agent' && !w.info.remote) {
        const frame = w.screenFrame ?? this.computeDaemonScreen(w);
        if (frame) out.push({ workerId: w.info.id, frame });
      }
    }
    return out;
  }

  private flushScreens() {
    const now = Date.now();
    for (const w of this.workers.values()) {
      if (w.term) {
        if (w.needsKeyframe && now - w.keyframeAt > KEYFRAME_MS) {
          w.keyframeAt = now;
          w.needsKeyframe = false;
          w.lastLines = [];
          w.screenDirty = true;
        }
        if (!w.screenDirty) continue;
        w.screenDirty = false;
        const frame = snapshotScreen(w.term, w.lastLines);
        if (frame) {
          if (frame.full) w.keyframeAt = now;
          if (this.events.screen(w.info.id, frame) === true) w.needsKeyframe = true;
        }
        continue;
      }
      if (w.info.kind !== 'agent' || w.info.remote || !w.screenDirty) continue;
      w.screenDirty = false;
      const frame = this.computeDaemonScreen(w);
      if (frame) this.events.screen(w.info.id, frame);
    }
  }

  private saveScrollback(w: Worker) {
    if (!w.term || !w.ser) return;
    w.unsaved = false;
    this.scrollback.save(w.info.id, terminalTail(w.term, w.ser, SCROLLBACK));
  }

  private persist(onShutdown = false) {
    this.state.save(this.workers.values(), { closing: this.closing, stopping: this.stopping, onShutdown });
  }
}
// ---------------------------------------------------------------------------

function offlineBanner(info: WorkerInfo): string {
  const hint = info.kind === 'shell' ? ' Press R to restart it.' : info.sessionId ? ' Press R to resume the session.' : '';
  return `\x1b[2m${info.name} is not running.${hint}\x1b[0m\r\n`;
}

/**
 * Sending every repository home. When each one deleted or kept the same branch, the sentence is the
 * one a single branch would get; otherwise each repository says what `sendHome` did.
 */
function reposHomeNote(name: string, branch: string, where: string, sent: { name: string; note?: string }[]): string {
  const notes = sent.map((t) => t.note);
  if (notes.every((n) => n === `worktree and branch ${branch}`)) return `Deleted ${name}'s worktrees and branch ${branch} in ${where}`;
  if (notes.every((n) => n === `worktree and kept branch ${branch}`)) return `Deleted ${name}'s worktrees in ${where} and kept branch ${branch}`;
  return `Deleted ${name}'s worktrees in ${where}: ${sent.map((t) => `${t.name} ${t.note}`).join('; ')}`;
}

/** Runs a command without blocking the office; rejects with the last lines of its stderr. */
function run(cmd: string, args: string[], cwd: string, timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').filter(Boolean).slice(-2).join(' ') || `${cmd} failed`));
      else resolve(stdout.trim());
    });
  });
}

/**
 * The folder each checkout gets in a workspace: its folder's name, made safe, with -2, -3… when two
 * checkouts share one (owner-a/api and owner-b/api).
 */
export function workspaceNames(dirs: string[]): string[] {
  const used = new Set<string>();
  return dirs.map((dir) => {
    let base =
      path
        .basename(path.resolve(dir))
        .replace(/[^\w.-]+/g, '-')
        .replace(/^[.-]+/, '') || 'project';
    if (WORKSPACE_FILES.has(base)) base = `${base}-repo`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}-${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** Takes a workspace folder away once its worktrees are gone: only the brief the office wrote, never anything else left in it. */
function clearWorkspace(abs: string) {
  try {
    for (const name of readdirSync(abs)) if (WORKSPACE_FILES.has(name)) unlinkSync(path.join(abs, name));
    rmdirSync(abs);
  } catch {
    // already gone, or something else is in it: it stays
  }
}

/** owner/name of a checkout's origin, when it has one the office can name. */
function originRepo(dir: string): string | undefined {
  try {
    return normalizeRepo(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim());
  } catch {
    return undefined;
  }
}

/** owner/name#12 for a pull request on GitHub (which links it with its title), else its URL. */
function prRef(url: string): string {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `${m[1]}#${m[2]}` : url;
}

/** The list of a change's pull requests across repositories, for the description of the one at `self`. */
export function relatedBlock(prs: { repo?: string; url: string }[], self: string, branch: string): string {
  const lines = prs.map((p) => `- ${p.repo ? `**${p.repo}**: ` : ''}${prRef(p.url)}${p.url === self ? ' (this one)' : ''}`);
  return [RELATED_START, `**One change across ${prs.length} repositories**, each on \`${branch}\`: review and merge them together.`, '', ...lines, RELATED_END].join('\n');
}

/** A description with its list of related pull requests put in, or brought up to date. */
export function withRelated(body: string, block: string): string {
  const at = body.indexOf(RELATED_START);
  const end = at < 0 ? -1 : body.indexOf(RELATED_END, at);
  if (end >= 0) return body.slice(0, at) + block + body.slice(end + RELATED_END.length);
  return body.trim() ? `${body.trimEnd()}\n\n${block}` : block;
}

/**
 * A pull request title and body from what the worker was asked to do. The title is the issue's
 * title when the task came off the issues board, else the task's first line; the body carries the
 * task, the commits, a "Closes #n" when the task asked for one, and which desk it came from. With
 * `other`, it's for one of the other repositories of a worker across repositories: the issue is its
 * own floor's (`home`), so this one only mentions it.
 */
function draftPr(info: WorkerInfo, commits: string[], by: string, other?: { home?: string }): { title: string; body: string } {
  const task = (info.prompt ?? '').replace(/\r\n?/g, '\n').trim();
  const firstLine =
    task
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  // The issues board hands work over as: Work on GitHub issue #12: "Title" (or GitLab issue).
  const issue = /\bissue #(\d+):\s*["“](.+?)["”]\.?\s*$/i.exec(firstLine);
  // …and a Linear ticket as: Work on Linear issue DOFF-12: "Title".
  const ticket = linearTaskOf(firstLine);
  const title = truncate(issue?.[2] || ticket?.title || firstLine.replace(/[.:;,]+$/, '') || commits[0]?.replace(/^\S+\s+/, '') || info.worktree?.branch || info.name, PR_TITLE_MAX);
  const closes = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[^\n]{0,40}?#(\d+)/i.exec(task)?.[1] ?? issue?.[1];
  const parts: string[] = [];
  if (task) parts.push(`## Task\n\n${task.length > PR_TASK_MAX ? `${task.slice(0, PR_TASK_MAX)}…` : task}`);
  parts.push(`## Commits\n\n${commits.map((c) => `- \`${c.slice(0, c.indexOf(' '))}\` ${c.slice(c.indexOf(' ') + 1)}`).join('\n')}`);
  if (closes && !other) parts.push(`Closes #${closes}`);
  else if (closes && other?.home) parts.push(`Part of ${other.home}#${closes}`);
  // Linear's GitHub and GitLab integrations link the pull request to the ticket on this magic word.
  if (ticket) parts.push(other ? `Part of ${ticket.identifier}` : `Fixes ${ticket.identifier}`);
  parts.push(`_Opened from Droid Office by ${by} · ${info.name} at ${DESK_BY_ID.get(info.deskId)?.label ?? info.deskId}_`);
  return { title, body: parts.join('\n\n') };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** How long a worker has spent working (ms), the stretch it's in now included. */
function workedMs(info: WorkerInfo, now = Date.now()): number | undefined {
  const ms = (info.workedMs ?? 0) + (info.workingSince === undefined ? 0 : Math.max(0, now - info.workingSince));
  return ms > 0 ? ms : undefined;
}

/** What starting a worker whose worktree was deleted (see WorkerInfo.lost) says instead. */
function lostMessage(info: WorkerInfo): string {
  return `${info.name}'s worktree ${workspaceOf(info)} was deleted outside droid-office — rebuild it or send ${info.name} home from its desk`;
}

/** Keeps count of how long a worker has worked (WorkerInfo.workedMs) as it goes from its status into `next`. */
export function clockWork(info: WorkerInfo, next: WorkerStatus, now = Date.now()) {
  if (next === 'working') {
    info.workingSince ??= now;
    return;
  }
  if (info.workingSince === undefined) return;
  info.workedMs = workedMs(info, now);
  info.workingSince = undefined;
}
