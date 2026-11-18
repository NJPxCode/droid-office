import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { AutonomyLevel, createWebSocketDaemonClient, DaemonDroidEvent, DroidInteractionMode, LOCAL_MACHINE_ID, MachineType, type ReasoningEffort, SDK_VERSION, ToolConfirmationOutcome, type DaemonClient } from '@factory/droid-sdk';
import type { AgentEffort, SubagentSettings } from '../shared/protocol.js';
import type { DroidSlashCommand } from '../shared/slash-commands.js';
import { cloudAsk, type CloudAsk } from './factory/cloud-ask.js';
import { record } from './factory/cloud-stream-messages.js';
import { readSetupFile } from './setup/index.js';
import { childEnv, resolveAgent } from './worker-runtime/process.js';

export type { CloudAsk };

/** Queue placement values accepted by `daemon.add_user_message` and `daemon.resolve_queued_user_message`. */
export type DaemonQueuePlacement = NonNullable<Parameters<DaemonClient['addUserMessage']>[0]['queuePlacement']>;

export const QueuePlacement = {
  EndOfTurn: 'end_of_turn' as DaemonQueuePlacement,
  EndOfLoop: 'end_of_loop' as DaemonQueuePlacement,
} as const;

type ResolveQueueCallParams = Parameters<DaemonClient['resolveQueuedUserMessage']>[0];
type UpdateQueueAction = Extract<ResolveQueueCallParams, { queuePlacement: unknown }>['action'];
type DeleteQueueAction = Exclude<ResolveQueueCallParams['action'], UpdateQueueAction>;

export const QueuedMessageAction = {
  UpdateQueue: 'update_queue' as UpdateQueueAction,
  Delete: 'delete' as DeleteQueueAction,
} as const;

export const AIRGAPPED_DAEMON_TOKEN = 'airgapped-token';

/** Ports reserved by Factory.app (`DEFAULT_PROD_PORT` / `DEFAULT_DEV_PORT`); Droid Office never picks them. */
const RESERVED_DAEMON_PORTS = new Set([37643, 41723]);

const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const KEYCHAIN_SERVICE = 'Factory CLI';
const KEYCHAIN_ACCOUNT = 'auth-encryption-key-security-cli';
const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 16;
const AES_TAG_BYTES = 16;
const JWT_EXPIRY_SKEW_MS = 60_000;

export interface PersistedDaemonInfo {
  pid: number;
  port: number;
  droidPath: string;
  airgapped: boolean;
  authFingerprint?: string;
  startedAt?: number;
}

export type LocalDaemonAuth =
  | { kind: 'airgapped'; token: string; fingerprint: string }
  | { kind: 'api-key'; apiKey: string; token: string; fingerprint: string }
  | { kind: 'workos'; token: string; activeOrganizationId?: string; fingerprint: string };

export interface FactoryWorkOsCredentials {
  access_token: string;
  refresh_token?: string;
  active_organization_id?: string | null;
}

export interface OfficeMcpConnectionConfig {
  hookUrl: string;
  workerHookToken: string;
  workerId: string;
  /** Defaults to true; pass false (e.g. `SubagentSettings.officeMcp === false`) to omit the MCP server. */
  enabled?: boolean;
}

export type DaemonHttpMcpServer = {
  type: 'http';
  name: string;
  url: string;
  headers: { name: string; value: string }[];
};

export interface LocalInitializeSessionOptions {
  cwd: string;
  sessionId?: string;
  modelId?: string;
  reasoningEffort?: AgentEffort | ReasoningEffort | string;
  title?: string;
  workerSystemPrompt?: string;
  mcp?: OfficeMcpConnectionConfig;
  mcpServers?: DaemonHttpMcpServer[];
  denyTask?: boolean;
  subagents?: Pick<SubagentSettings, 'officeMcp' | 'denyTask'>;
  disabledToolIds?: string[];
  pullFromOrigin?: boolean;
}

export interface LocalLoadSessionOptions {
  sessionId: string;
  mcp?: OfficeMcpConnectionConfig;
  mcpServers?: DaemonHttpMcpServer[];
  denyTask?: boolean;
  subagents?: Pick<SubagentSettings, 'officeMcp' | 'denyTask'>;
  disabledToolIds?: string[];
  loadAllMessages?: boolean;
  messageLimit?: number;
}

export type LocalBase64ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface LocalBase64Image {
  type: 'base64';
  data: string;
  mediaType: LocalBase64ImageMediaType;
}

/** Accepts structured base64 objects, `data:image/...;base64,...` URLs, or local file paths. */
export type LocalImageInput = LocalBase64Image | string;

export interface LocalAddUserMessageParams {
  sessionId: string;
  text: string;
  /** `false` (default) steers at `EndOfTurn`; `true` queues behind the turn at `EndOfLoop`. */
  queue?: boolean;
  queuePlacement?: DaemonQueuePlacement;
  images?: LocalImageInput[];
  imagePaths?: string[];
  requestId?: string;
  messageId?: string;
  pullFromOrigin?: boolean;
}

export type LocalResolveQueuedParams = { sessionId: string; requestId: string; action: 'update_queue'; queuePlacement?: DaemonQueuePlacement } | { sessionId: string; requestId: string; action: 'delete' };

export interface LocalRewindFileSnapshot {
  filePath: string;
  contentHash: string;
  size: number;
}

export interface LocalRewindFileCreation {
  filePath: string;
}

export interface LocalRewindEvictedFile {
  filePath: string;
  reason: string;
}

export interface LocalRewindInfo {
  availableFiles: LocalRewindFileSnapshot[];
  createdFiles: LocalRewindFileCreation[];
  evictedFiles: LocalRewindEvictedFile[];
}

export interface LocalExecuteRewindParams {
  sessionId: string;
  messageId: string;
  filesToRestore: LocalRewindFileSnapshot[];
  filesToDelete: LocalRewindFileCreation[];
  forkTitle: string;
}

export interface LocalExecuteRewindResult {
  newSessionId: string;
  restoredCount: number;
  deletedCount: number;
  failedRestoreCount: number;
  failedDeleteCount: number;
}

export interface LocalCompactSessionParams {
  sessionId: string;
  customInstructions?: string;
  mode?: 'handoff';
}

export interface LocalCompactSessionResult {
  newSessionId: string;
  removedCount: number;
}

export interface LocalForkSessionParams {
  sessionId: string;
  title?: string;
  tags?: { name: string; metadata?: Record<string, string> }[];
  /** Target working directory (e.g. a newly created git worktree) to move the forked session into. */
  cwd?: string;
  /** Options forwarded when loading `newSessionId` (always loaded when `cwd` is set). */
  loadOptions?: Omit<LocalLoadSessionOptions, 'sessionId'>;
  /** Close `sessionId` after forking when the daemon did not already have it open (default true). */
  closeUnownedSource?: boolean;
}

export interface LocalForkSessionResult {
  newSessionId: string;
  resolvedCwd?: string;
  snapshot?: Record<string, unknown>;
}

export interface LocalUpdateSettingsParams {
  sessionId: string;
  modelId?: string;
  reasoningEffort?: AgentEffort | ReasoningEffort | string;
  interactionMode?: DroidInteractionMode;
  autonomyLevel?: AutonomyLevel;
  disabledToolIds?: string[];
}

export interface LocalDaemonNotification extends Record<string, unknown> {
  type: string;
}

export interface LocalSessionNotificationEvent {
  sessionId: string;
  notification: LocalDaemonNotification;
}

export interface LocalAskUserEvent {
  sessionId: string;
  ask: CloudAsk | undefined;
}

export interface LocalAdoptSessionSpec extends LocalLoadSessionOptions {}

export interface LocalAdoptResult {
  openedSessionIds: string[];
  adopted: Map<string, Record<string, unknown>>;
  failed: Map<string, Error>;
}

/** Minimal transport-facing subset of `DaemonClient` so unit tests can inject a deterministic client double. */
export type LocalDaemonSdkClient = Pick<
  DaemonClient,
  | 'connect'
  | 'disconnect'
  | 'destroy'
  | 'isConnected'
  | 'authenticate'
  | 'initializeSession'
  | 'loadSession'
  | 'addUserMessage'
  | 'resolveQueuedUserMessage'
  | 'interruptSession'
  | 'closeSession'
  | 'listOpenedSessions'
  | 'updateSessionSettings'
  | 'changeWorkingDirectory'
  | 'checkFolderTrust'
  | 'trustFolder'
  | 'getRewindInfo'
  | 'executeRewind'
  | 'compactSession'
  | 'forkSession'
  | 'listSkills'
  | 'listCommands'
  | 'listModels'
  | 'sendPermissionResponse'
  | 'sendAskUserResponse'
  | 'onTransportMessage'
  | 'onConnectionClose'
  | 'onConnectionError'
>;

export interface SpawnedDaemonProcess {
  pid?: number;
  unref(): void;
  once(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown;
}

export interface LocalDaemonOptions {
  /** Office-wide `.droid-office` directory where `droid-daemon.json` and `setup.json` live. */
  dataDir: string;
  /** Agent command or resolved binary path (default `'droid'`). */
  agentCmd?: string | (() => string);
  /** Returns Office's configured `fk-*` Factory API key when connected (`FactoryOffice.key()`). */
  apiKey?: () => string | undefined;
  /** Returns whether Airgapped mode is active; defaults to reading `setup.json` in `dataDir`. */
  airgapped?: () => boolean;
  /** Home directory containing `.factory/auth.v2.*`; defaults to `os.homedir()`. */
  home?: string;
  platform?: NodeJS.Platform;
  /** Clean child environment builder; defaults to `childEnv`. */
  env?: () => Record<string, string>;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
  resolveDroidPath?: (cmd: string) => string | null;
  pickPort?: () => Promise<number>;
  isPidAlive?: (pid: number) => boolean;
  killPid?: (pid: number, signal?: NodeJS.Signals) => void;
  spawnDaemon?: (droidPath: string, args: string[], env: Record<string, string>, logFile: string) => SpawnedDaemonProcess;
  createClient?: (auth: LocalDaemonAuth) => LocalDaemonSdkClient;
  readKeychainKey?: () => Promise<string | null>;
  refreshWorkOsAuth?: (droidPath: string, env: Record<string, string>) => Promise<void>;
}

/** Decrypts Droid's `auth.v2.file` / `auth.v2.loginkeychain` (`<iv_b64>:<tag_b64>:<ciphertext_b64>`, AES-256-GCM, 16-byte IV & tag). */
export function decryptFactoryAuthV2(ciphertext: string, key: Buffer): FactoryWorkOsCredentials {
  if (key.length !== AES_KEY_BYTES) throw new Error(`Invalid Factory auth key length: expected ${AES_KEY_BYTES}, got ${key.length}`);
  const parts = ciphertext.trim().split(':');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error('Invalid encrypted Factory auth format');
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const encrypted = Buffer.from(parts[2], 'base64');
  if (iv.length !== AES_IV_BYTES || tag.length !== AES_TAG_BYTES) throw new Error('Invalid Factory auth IV or auth tag length');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const json = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  const parsed = record(JSON.parse(json));
  if (typeof parsed.access_token !== 'string' || !parsed.access_token.trim()) {
    throw new Error('Decrypted Factory credentials contain no access_token');
  }
  return {
    access_token: parsed.access_token.trim(),
    ...(typeof parsed.refresh_token === 'string' && parsed.refresh_token.trim() ? { refresh_token: parsed.refresh_token.trim() } : {}),
    ...(typeof parsed.active_organization_id === 'string' || parsed.active_organization_id === null ? { active_organization_id: parsed.active_organization_id } : {}),
  };
}

/** True when a JWT `access_token` has a parseable `exp` claim at or within `skewMs` of `now`. */
export function isJwtExpired(token: string, now = Date.now(), skewMs = JWT_EXPIRY_SKEW_MS): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return false;
    const payload = record(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return false;
    return now >= payload.exp * 1000 - skewMs;
  } catch {
    return false;
  }
}

function readMacKeychainAuthKey(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'], { encoding: 'utf8', timeout: 5_000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const trimmed = stdout.replace(/\r?\n$/, '').trim();
      resolve(trimmed || null);
    });
  });
}

function defaultRefreshWorkOsAuth(droidPath: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve) => {
    execFile(droidPath, ['doctor', '--json', '--checks', 'auth'], { encoding: 'utf8', timeout: 30_000, env }, () => resolve());
  });
}

function decodeBase64Key(raw: string | null | undefined): Buffer | null {
  if (!raw?.trim()) return null;
  const buf = Buffer.from(raw.trim(), 'base64');
  return buf.length === AES_KEY_BYTES ? buf : null;
}

/**
 * Reads Droid's local WorkOS credentials in Droid 1.13's exact resolution order:
 * 1. macOS Keychain (`~/.factory/auth.v2.loginkeychain` + `security` key) unless `FACTORY_DISABLE_KEYRING` is set,
 * 2. Keyfile (`~/.factory/auth.v2.file` + `~/.factory/auth.v2.key`).
 */
export async function readFactoryWorkOsAuth(opts: { home: string; platform: NodeJS.Platform; disableKeyring?: boolean; readKeychainKey?: () => Promise<string | null> }): Promise<FactoryWorkOsCredentials | null> {
  const factoryDir = path.join(opts.home, '.factory');
  if (!opts.disableKeyring && opts.platform === 'darwin') {
    const keychainFile = path.join(factoryDir, 'auth.v2.loginkeychain');
    if (existsSync(keychainFile)) {
      try {
        const cipher = readFileSync(keychainFile, 'utf8');
        const keyB64 = await (opts.readKeychainKey ?? readMacKeychainAuthKey)();
        const key = decodeBase64Key(keyB64);
        if (key) return decryptFactoryAuthV2(cipher, key);
      } catch {
        // fall back to keyfile-v2
      }
    }
  }
  const authFile = path.join(factoryDir, 'auth.v2.file');
  const keyFile = path.join(factoryDir, 'auth.v2.key');
  if (!existsSync(authFile) || !existsSync(keyFile)) return null;
  try {
    const key = decodeBase64Key(readFileSync(keyFile, 'utf8'));
    if (!key) return null;
    return decryptFactoryAuthV2(readFileSync(authFile, 'utf8'), key);
  } catch {
    return null;
  }
}

/**
 * Builds the `droid-office` HTTP MCP entry for `initializeSession` and `loadSession`.
 * Critically omits the `oauth` property completely so `@factory/droid-sdk` never throws
 * `requireMcpOAuthOptOutSupport()` `ProtocolError` or fails `McpOAuthConfigSchema`.
 */
export function buildOfficeMcpServers(mcp?: OfficeMcpConnectionConfig): DaemonHttpMcpServer[] | undefined {
  if (!mcp || mcp.enabled === false) return undefined;
  const baseUrl = mcp.hookUrl.replace(/\/+$/, '');
  if (!baseUrl || !mcp.workerHookToken || !mcp.workerId) return undefined;
  return [
    {
      type: 'http',
      name: 'droid-office',
      url: `${baseUrl}/office/mcp`,
      headers: [
        { name: 'Authorization', value: `Bearer ${mcp.workerHookToken}` },
        { name: 'x-droid-office-worker-id', value: mcp.workerId },
        { name: 'x-droid-office-url', value: baseUrl },
      ],
    },
  ];
}

type PermissionOutcome = Parameters<DaemonClient['sendPermissionResponse']>[1]['selectedOption'];

/** Picks `'proceed_once'` when offered, else the first non-cancel, non-`proceed_edit` option offered. */
export function pickPermissionApprovalOption(options: unknown): PermissionOutcome {
  if (Array.isArray(options) && options.length > 0) {
    const values = options.map((item) => (typeof item === 'string' ? item : typeof record(item).value === 'string' ? (record(item).value as string) : '')).filter(Boolean);
    if (values.includes(ToolConfirmationOutcome.ProceedOnce)) {
      return ToolConfirmationOutcome.ProceedOnce;
    }
    const nonCancel = values.find((v) => v !== ToolConfirmationOutcome.Cancel && v !== ToolConfirmationOutcome.ProceedEdit);
    if (nonCancel) return nonCancel as PermissionOutcome;
  }
  return ToolConfirmationOutcome.ProceedOnce;
}

/** Binds an ephemeral loopback TCP port on `127.0.0.1`, avoiding Factory.app's reserved daemon ports. */
export async function pickFreeLoopbackPort(): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const picked = typeof addr === 'object' && addr ? addr.port : 0;
        server.close((err) => (err ? reject(err) : resolve(picked)));
      });
    });
    if (port > 0 && !RESERVED_DAEMON_PORTS.has(port)) return port;
  }
  throw new Error('Could not allocate a free loopback port for droid daemon');
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function defaultKillPid(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, signal);
  } catch {
    // already exited
  }
}

function defaultSpawnDaemon(droidPath: string, args: string[], env: Record<string, string>, logFile: string): ChildProcess {
  mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  let fd: number | undefined;
  try {
    fd = openSync(logFile, 'a', 0o600);
  } catch {
    fd = undefined;
  }
  try {
    const child = spawn(droidPath, args, {
      detached: true,
      stdio: fd !== undefined ? ['ignore', fd, fd] : 'ignore',
      env,
    });
    child.unref();
    return child;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close error
      }
    }
  }
}

function writePrivateJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function readPersistedDaemonInfo(file: string): PersistedDaemonInfo | null {
  if (!existsSync(file)) return null;
  try {
    const raw = record(JSON.parse(readFileSync(file, 'utf8')));
    if (
      typeof raw.pid !== 'number' ||
      !Number.isInteger(raw.pid) ||
      raw.pid <= 0 ||
      typeof raw.port !== 'number' ||
      !Number.isInteger(raw.port) ||
      raw.port <= 0 ||
      typeof raw.droidPath !== 'string' ||
      !raw.droidPath ||
      typeof raw.airgapped !== 'boolean'
    ) {
      return null;
    }
    return {
      pid: raw.pid,
      port: raw.port,
      droidPath: raw.droidPath,
      airgapped: raw.airgapped,
      ...(typeof raw.authFingerprint === 'string' ? { authFingerprint: raw.authFingerprint } : {}),
      ...(typeof raw.startedAt === 'number' ? { startedAt: raw.startedAt } : {}),
    };
  } catch {
    return null;
  }
}

function parseDataUrlImage(value: string): LocalBase64Image | null {
  const m = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(value.trim());
  if (!m) return null;
  return {
    type: 'base64',
    mediaType: m[1].toLowerCase() as LocalBase64ImageMediaType,
    data: m[2].replace(/\s+/g, ''),
  };
}

function normalizeImages(images?: LocalImageInput[], extraPaths?: string[]): { images?: LocalBase64Image[]; imagePaths?: string[] } {
  const base64: LocalBase64Image[] = [];
  const paths: string[] = [];
  for (const item of images ?? []) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const parsed = parseDataUrlImage(trimmed);
      if (parsed) base64.push(parsed);
      else paths.push(trimmed);
    } else if (item && item.type === 'base64' && item.data && item.mediaType) {
      base64.push(item);
    }
  }
  for (const p of extraPaths ?? []) {
    const trimmed = p.trim();
    if (trimmed) paths.push(trimmed);
  }
  return {
    ...(base64.length ? { images: base64 } : {}),
    ...(paths.length ? { imagePaths: paths } : {}),
  };
}

function resolveDisabledTools(opts: { denyTask?: boolean; subagents?: Pick<SubagentSettings, 'denyTask'>; disabledToolIds?: string[] }): string[] | undefined {
  const set = new Set<string>(opts.disabledToolIds ?? []);
  const denyTask = opts.denyTask ?? opts.subagents?.denyTask ?? false;
  if (denyTask) set.add('Task');
  return set.size ? [...set] : undefined;
}

function resolveMcpServers(opts: { mcp?: OfficeMcpConnectionConfig; mcpServers?: DaemonHttpMcpServer[]; subagents?: Pick<SubagentSettings, 'officeMcp'> }): DaemonHttpMcpServer[] | undefined {
  const out: DaemonHttpMcpServer[] = [];
  if (opts.mcp && opts.subagents?.officeMcp !== false) {
    const office = buildOfficeMcpServers(opts.mcp);
    if (office) out.push(...office);
  }
  if (opts.mcpServers?.length) {
    for (const s of opts.mcpServers) {
      // Strip any accidental `oauth` key so `requireMcpOAuthOptOutSupport()` never trips.
      const { type, name, url, headers } = s;
      out.push({ type, name, url, headers });
    }
  }
  return out.length ? out : undefined;
}

/**
 * Manages the single detached local `droid daemon` process and WebSocket `DaemonClient` for all
 * local Droid desk workers and the Mission Control Orchestrator.
 */
export class LocalDaemon {
  readonly stateFile: string;
  readonly logFile: string;

  private client?: LocalDaemonSdkClient;
  private activeDaemon?: PersistedDaemonInfo;
  private activeAuth?: LocalDaemonAuth;
  private starting?: Promise<void>;
  private airgappedOverride?: boolean;
  private detaching = false;
  private stopped = false;

  private readonly loadedSessions = new Set<string>();
  private readonly trustedFolders = new Set<string>();
  private readonly pendingAsks = new Map<string, CloudAsk>();
  private readonly notificationListeners = new Set<(event: LocalSessionNotificationEvent) => void>();
  private readonly sessionListeners = new Map<string, Set<(notification: LocalDaemonNotification) => void>>();
  private readonly askListeners = new Set<(event: LocalAskUserEvent) => void>();
  private readonly connectionLostListeners = new Set<() => void>();

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly env: () => Record<string, string>;
  private readonly home: string;
  private readonly platform: NodeJS.Platform;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly killPid: (pid: number, signal?: NodeJS.Signals) => void;
  private readonly spawnDaemon: (droidPath: string, args: string[], env: Record<string, string>, logFile: string) => SpawnedDaemonProcess;
  private readonly pickPort: () => Promise<number>;
  private readonly resolveDroid: (cmd: string) => string | null;

  constructor(private readonly opts: LocalDaemonOptions) {
    this.stateFile = path.join(opts.dataDir, 'droid-daemon.json');
    this.logFile = path.join(opts.dataDir, 'droid-daemon.log');
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.env = opts.env ?? childEnv;
    this.home = opts.home ?? os.homedir();
    this.platform = opts.platform ?? process.platform;
    this.isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
    this.killPid = opts.killPid ?? defaultKillPid;
    this.spawnDaemon = opts.spawnDaemon ?? defaultSpawnDaemon;
    this.pickPort = opts.pickPort ?? pickFreeLoopbackPort;
    this.resolveDroid = opts.resolveDroidPath ?? resolveAgent;
  }

  /** Current persisted/connected daemon metadata, if running. */
  info(): PersistedDaemonInfo | null {
    return this.activeDaemon ? { ...this.activeDaemon } : readPersistedDaemonInfo(this.stateFile);
  }

  isConnected(): boolean {
    return Boolean(this.client?.isConnected());
  }

  /** Latest pending `AskUser` held for `sessionId`, if any. */
  pendingAsk(sessionId: string): CloudAsk | undefined {
    return this.pendingAsks.get(sessionId);
  }

  /** Subscribe to all `daemon.session_notification` events across loaded sessions. */
  onSessionNotification(handler: (event: LocalSessionNotificationEvent) => void): () => void;
  /** Subscribe to `daemon.session_notification` events for one `sessionId`. */
  onSessionNotification(sessionId: string, handler: (notification: LocalDaemonNotification) => void): () => void;
  onSessionNotification(first: string | ((event: LocalSessionNotificationEvent) => void), second?: (notification: LocalDaemonNotification) => void): () => void {
    if (typeof first === 'function') {
      this.notificationListeners.add(first);
      return () => this.notificationListeners.delete(first);
    }
    const handler = second!;
    let set = this.sessionListeners.get(first);
    if (!set) {
      set = new Set();
      this.sessionListeners.set(first, set);
    }
    set.add(handler);
    return () => {
      const current = this.sessionListeners.get(first);
      if (!current) return;
      current.delete(handler);
      if (!current.size) this.sessionListeners.delete(first);
    };
  }

  /** Subscribe to structured `AskUser` requests (`ask === undefined` when cleared or absent on load). */
  onAskUser(handler: (event: LocalAskUserEvent) => void): () => void {
    this.askListeners.add(handler);
    return () => this.askListeners.delete(handler);
  }

  /** Subscribe to unexpected daemon WebSocket drops (ignored during intentional `disconnect()` / `stop()`). */
  onConnectionLost(handler: () => void): () => void {
    this.connectionLostListeners.add(handler);
    return () => this.connectionLostListeners.delete(handler);
  }

  /** Binds `SIGTERM` -> `disconnect()` (leave daemon running across Office restart) and `SIGINT` -> `stop()` (kill daemon). */
  bindProcessSignals(proc: Pick<NodeJS.Process, 'on' | 'off'> = process): () => void {
    const onSigTerm = () => this.disconnect();
    const onSigInt = () => this.stop();
    proc.on('SIGTERM', onSigTerm);
    proc.on('SIGINT', onSigInt);
    return () => {
      proc.off('SIGTERM', onSigTerm);
      proc.off('SIGINT', onSigInt);
    };
  }

  /**
   * Toggles Airgapped mode (`FACTORY_AIRGAP_ENABLED=1` + `'airgapped-token'`).
   * If a daemon is currently running in the opposite mode, kills it and restarts cleanly.
   */
  async setAirgapped(airgapped: boolean): Promise<void> {
    const previous = this.currentAirgapped();
    this.airgappedOverride = airgapped;
    const persisted = this.activeDaemon ?? readPersistedDaemonInfo(this.stateFile);
    if (!persisted && previous === airgapped) return;
    const wasRunning = Boolean(this.client || (persisted && this.isPidAlive(persisted.pid)));
    if (persisted && persisted.airgapped !== airgapped) {
      this.killDaemonInstance(persisted);
    } else if (this.activeDaemon && this.activeDaemon.airgapped !== airgapped) {
      this.killDaemonInstance(this.activeDaemon);
    } else {
      return;
    }
    if (wasRunning && !this.stopped) {
      await this.ensureStarted();
    }
  }

  /**
   * Normal Office restart (`SIGTERM`): closes the WebSocket connection while leaving the detached
   * `droid daemon` process and `.droid-office/droid-daemon.json` intact so in-flight turns continue.
   */
  disconnect(): void {
    this.detaching = true;
    try {
      this.closeClient();
    } finally {
      this.detaching = false;
    }
  }

  /**
   * "Quit and Stop Workers" (`SIGINT`): closes the WebSocket connection, terminates the detached
   * `droid daemon` PID, and removes `.droid-office/droid-daemon.json`.
   */
  stop(): void {
    this.stopped = true;
    this.detaching = true;
    try {
      this.closeClient();
      const persisted = this.activeDaemon ?? readPersistedDaemonInfo(this.stateFile);
      this.activeDaemon = undefined;
      if (persisted) {
        this.killPid(persisted.pid, 'SIGTERM');
      }
      this.removeStateFile();
    } finally {
      this.detaching = false;
    }
  }

  /** Resolves current authentication credentials (`airgapped-token`, `fk-*` API key, or local WorkOS JWT). */
  async resolveAuth(droidPath?: string): Promise<LocalDaemonAuth> {
    if (this.currentAirgapped()) {
      return { kind: 'airgapped', token: AIRGAPPED_DAEMON_TOKEN, fingerprint: 'airgapped' };
    }
    const configuredKey = this.opts.apiKey?.()?.trim();
    if (configuredKey) {
      const hash = createHash('sha256').update(configuredKey).digest('hex').slice(0, 16);
      return { kind: 'api-key', apiKey: configuredKey, token: configuredKey, fingerprint: `api-key:${hash}` };
    }
    const baseEnv = this.env();
    const disableKeyring = baseEnv.FACTORY_DISABLE_KEYRING === '1' || baseEnv.FACTORY_DISABLE_KEYRING === 'true';
    let creds = await readFactoryWorkOsAuth({
      home: this.home,
      platform: this.platform,
      disableKeyring,
      readKeychainKey: this.opts.readKeychainKey,
    });
    if (creds && isJwtExpired(creds.access_token, this.now())) {
      const resolvedDroid = droidPath ?? this.resolveDroidBinary();
      if (resolvedDroid) {
        await (this.opts.refreshWorkOsAuth ?? defaultRefreshWorkOsAuth)(resolvedDroid, baseEnv);
        const refreshed = await readFactoryWorkOsAuth({
          home: this.home,
          platform: this.platform,
          disableKeyring,
          readKeychainKey: this.opts.readKeychainKey,
        });
        if (refreshed) creds = refreshed;
      }
    }
    if (!creds) {
      throw new Error('Droid is not signed in and no Factory API key is configured.');
    }
    return {
      kind: 'workos',
      token: creds.access_token,
      ...(creds.active_organization_id ? { activeOrganizationId: creds.active_organization_id } : {}),
      fingerprint: 'workos',
    };
  }

  /** Ensures a matching `droid daemon` is running and authenticated over WebSocket. */
  async ensureStarted(): Promise<void> {
    if (this.stopped) throw new Error('LocalDaemon has been stopped');
    const droidPath = this.resolveDroidBinary();
    if (!droidPath) throw new Error('Droid CLI executable could not be found');
    const airgapped = this.currentAirgapped();
    const auth = await this.resolveAuth(droidPath);

    if (
      this.client?.isConnected() &&
      this.activeDaemon &&
      this.activeDaemon.droidPath === droidPath &&
      this.activeDaemon.airgapped === airgapped &&
      this.activeDaemon.authFingerprint === auth.fingerprint &&
      this.sameToken(this.activeAuth, auth)
    ) {
      return;
    }

    if (this.starting) {
      await this.starting;
      if (this.client?.isConnected() && this.activeDaemon?.droidPath === droidPath && this.activeDaemon?.airgapped === airgapped && this.activeDaemon?.authFingerprint === auth.fingerprint) {
        return;
      }
    }

    const run = this.startOrAttach(droidPath, airgapped, auth).finally(() => {
      if (this.starting === run) this.starting = undefined;
    });
    this.starting = run;
    await run;
  }

  /** Lists sessions currently open in the running `droid daemon`. */
  async listOpenedSessions() {
    const client = await this.readyClient();
    const res = await client.listOpenedSessions({});
    return res.sessions;
  }

  /**
   * Reconnects to a running daemon after an Office restart, inspects `listOpenedSessions`, and calls
   * `loadSession` on each saved worker session to reattach live `session_notification` streaming and
   * pending `AskUser` state.
   */
  async adoptSessions(sessions: readonly (string | LocalAdoptSessionSpec)[]): Promise<LocalAdoptResult> {
    await this.ensureStarted();
    const opened = await this.listOpenedSessions();
    const openedSessionIds = opened.map((s) => s.sessionId);
    const adopted = new Map<string, Record<string, unknown>>();
    const failed = new Map<string, Error>();
    for (const item of sessions) {
      const spec: LocalAdoptSessionSpec = typeof item === 'string' ? { sessionId: item } : item;
      if (!spec.sessionId) continue;
      try {
        const snapshot = await this.loadSession(spec);
        adopted.set(spec.sessionId, snapshot);
      } catch (err) {
        failed.set(spec.sessionId, err instanceof Error ? err : new Error(String(err)));
      }
    }
    return { openedSessionIds, adopted, failed };
  }

  /** Ensures `folderPath` is trusted by `droid daemon` so session init and worktree `cwd` switches succeed. */
  async ensureFolderTrusted(folderPath: string): Promise<void> {
    const resolved = path.resolve(folderPath);
    if (this.trustedFolders.has(resolved)) return;
    const client = await this.readyClient();
    const status = await client.checkFolderTrust({ path: resolved });
    if (!status.isTrusted) {
      const trusted = await client.trustFolder({ path: resolved });
      if (trusted.trustRootPath) this.trustedFolders.add(trusted.trustRootPath);
    } else if (status.trustRootPath) {
      this.trustedFolders.add(status.trustRootPath);
    }
    this.trustedFolders.add(resolved);
  }

  /** Creates a new autonomous local Droid session with Office MCP and system prompt preset. */
  async initializeSession(options: LocalInitializeSessionOptions): Promise<{ sessionId: string; settings: Record<string, unknown>; session: Record<string, unknown> }> {
    await this.ensureStarted();
    const cwd = path.resolve(options.cwd);
    await this.ensureFolderTrusted(cwd);
    const client = await this.readyClient();
    const token = this.requireToken();
    const mcpServers = resolveMcpServers(options);
    const disabledToolIds = resolveDisabledTools(options);
    const append = options.workerSystemPrompt?.trim() ? options.workerSystemPrompt : undefined;

    const result = await client.initializeSession({
      machineId: LOCAL_MACHINE_ID,
      cwd,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      token,
      skipPermissionsUnsafe: true,
      interactionMode: DroidInteractionMode.Auto,
      autonomyLevel: AutonomyLevel.High,
      disableInactivityTimeout: true,
      ...(options.modelId ? { modelId: options.modelId } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort as ReasoningEffort } : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(disabledToolIds ? { disabledToolIds } : {}),
      ...(append ? { systemPrompt: { type: 'preset', preset: 'droid', append } } : {}),
      ...(options.pullFromOrigin !== undefined ? { pullFromOrigin: options.pullFromOrigin } : {}),
    });
    this.loadedSessions.add(result.sessionId);
    this.pendingAsks.delete(result.sessionId);
    return {
      sessionId: result.sessionId,
      settings: record(result.settings),
      session: record(result.session),
    };
  }

  /**
   * Loads/resumes an existing local Droid session with `skipPermissionsUnsafe: true`,
   * `disableInactivityTimeout: true`, `interactionMode: 'auto'`, and `autonomyLevel: 'high'`,
   * auto-approving any pending permissions and surfacing any pending `AskUser`.
   */
  async loadSession(options: LocalLoadSessionOptions): Promise<Record<string, unknown>> {
    await this.ensureStarted();
    const client = await this.readyClient();
    const token = this.requireToken();
    const mcpServers = resolveMcpServers(options);
    const disabledToolIds = resolveDisabledTools(options);

    const rawSnapshot = await client.loadSession({
      sessionId: options.sessionId,
      token,
      skipPermissionsUnsafe: true,
      disableInactivityTimeout: true,
      ...(mcpServers ? { mcpServers } : {}),
      ...(disabledToolIds ? { disabledToolIds } : {}),
      ...(options.loadAllMessages !== undefined ? { loadAllMessages: options.loadAllMessages } : {}),
      ...(options.messageLimit !== undefined ? { messageLimit: options.messageLimit } : {}),
    });
    this.loadedSessions.add(options.sessionId);
    const snapshot = record(rawSnapshot);
    const settings = record(snapshot.settings);

    // `daemon.load_session` schema omits `interactionMode` / `autonomyLevel`; enforce both immediately on load.
    if (settings.interactionMode !== DroidInteractionMode.Auto || settings.autonomyLevel !== AutonomyLevel.High) {
      await client.updateSessionSettings({
        sessionId: options.sessionId,
        interactionMode: DroidInteractionMode.Auto,
        autonomyLevel: AutonomyLevel.High,
        ...(disabledToolIds ? { disabledToolIds } : {}),
      });
      settings.interactionMode = DroidInteractionMode.Auto;
      settings.autonomyLevel = AutonomyLevel.High;
      snapshot.settings = settings;
    }

    this.autoApproveSnapshotPermissions(client, options.sessionId, snapshot.pendingPermissions);
    this.syncSnapshotAskUser(options.sessionId, snapshot.pendingAskUserRequests);
    return snapshot;
  }

  /** Sends or queues a user message (`EndOfTurn` steer when `queue` is false/unset, `EndOfLoop` queue when `queue: true`). */
  async addUserMessage(params: LocalAddUserMessageParams): Promise<{ requestId: string }> {
    const client = await this.readyClient();
    const requestId = params.requestId ?? randomUUID();
    const queuePlacement = params.queuePlacement ?? (params.queue ? QueuePlacement.EndOfLoop : QueuePlacement.EndOfTurn);
    const normalizedImages = normalizeImages(params.images, params.imagePaths);
    await client.addUserMessage(
      {
        sessionId: params.sessionId,
        messageId: params.messageId ?? requestId,
        text: params.text,
        queuePlacement,
        ...normalizedImages,
        ...(params.pullFromOrigin !== undefined ? { pullFromOrigin: params.pullFromOrigin } : {}),
      },
      requestId,
    );
    return { requestId };
  }

  /** Promotes (`action: 'update_queue'`) or deletes (`action: 'delete'`) a queued user message by `requestId`. */
  async resolveQueuedUserMessage(params: LocalResolveQueuedParams): Promise<void> {
    const client = await this.readyClient();
    if (params.action === 'delete') {
      await client.resolveQueuedUserMessage({ sessionId: params.sessionId, requestId: params.requestId, action: QueuedMessageAction.Delete });
      return;
    }
    await client.resolveQueuedUserMessage({
      sessionId: params.sessionId,
      requestId: params.requestId,
      action: QueuedMessageAction.UpdateQueue,
      queuePlacement: params.queuePlacement ?? QueuePlacement.EndOfTurn,
    });
  }

  async promoteQueuedMessage(sessionId: string, requestId: string): Promise<void> {
    await this.resolveQueuedUserMessage({ sessionId, requestId, action: 'update_queue', queuePlacement: QueuePlacement.EndOfTurn });
  }

  async deleteQueuedMessage(sessionId: string, requestId: string): Promise<void> {
    await this.resolveQueuedUserMessage({ sessionId, requestId, action: 'delete' });
  }

  /** Sends the owner's answers for a pending `AskUser` questionnaire (`daemon.ask_user`). */
  sendAskUserResponse(requestId: string, result: { sessionId: string; answers: { index: number; question: string; answer: string }[]; cancelled?: boolean }): boolean {
    if (!this.client?.isConnected()) return false;
    this.client.sendAskUserResponse(requestId, result);
    if (this.pendingAsks.get(result.sessionId)?.requestId === requestId) {
      this.pendingAsks.delete(result.sessionId);
      this.emitAskUser({ sessionId: result.sessionId, ask: undefined });
    }
    return true;
  }

  /** Updates model, reasoning effort, or autonomy settings on an active session. */
  async updateSessionSettings(params: LocalUpdateSettingsParams): Promise<void> {
    const client = await this.readyClient();
    await client.updateSessionSettings({
      sessionId: params.sessionId,
      ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
      ...(params.reasoningEffort !== undefined ? { reasoningEffort: params.reasoningEffort as ReasoningEffort } : {}),
      ...(params.interactionMode !== undefined ? { interactionMode: params.interactionMode } : {}),
      ...(params.autonomyLevel !== undefined ? { autonomyLevel: params.autonomyLevel } : {}),
      ...(params.disabledToolIds !== undefined ? { disabledToolIds: params.disabledToolIds } : {}),
    });
  }

  /** Interrupts the active turn on `sessionId`. */
  async interruptSession(sessionId: string): Promise<void> {
    const client = await this.readyClient();
    await client.interruptSession({ sessionId });
  }

  /** Closes `sessionId` on the daemon (stopping its session worker without deleting transcript files). */
  async closeSession(sessionId: string, opts?: { preserveEmptyDraft?: boolean }): Promise<void> {
    const client = await this.readyClient();
    this.loadedSessions.delete(sessionId);
    this.pendingAsks.delete(sessionId);
    await client.closeSession({
      sessionId,
      ...(opts?.preserveEmptyDraft !== undefined ? { preserveEmptyDraft: opts.preserveEmptyDraft } : {}),
    });
  }

  /** Inspects restorable/created/evicted files before `messageId`. */
  async getRewindInfo(params: { sessionId: string; messageId: string }): Promise<LocalRewindInfo> {
    const client = await this.readyClient();
    return client.getRewindInfo(params);
  }

  /** Executes a rewind before `messageId`, returning the newly forked `newSessionId` and file counts. */
  async executeRewind(params: LocalExecuteRewindParams): Promise<LocalExecuteRewindResult> {
    const client = await this.readyClient();
    return client.executeRewind(params);
  }

  /** Compacts `sessionId` in place (`mode` omitted) or summarizes into a new handoff session (`mode: 'handoff'`). */
  async compactSession(params: LocalCompactSessionParams): Promise<LocalCompactSessionResult> {
    const client = await this.readyClient();
    return client.compactSession({
      sessionId: params.sessionId,
      ...(params.customInstructions !== undefined ? { customInstructions: params.customInstructions } : {}),
      ...(params.mode !== undefined ? { mode: params.mode } : {}),
    });
  }

  /** Changes `sessionId`'s working directory after ensuring the target directory is trusted. */
  async changeWorkingDirectory(params: { sessionId: string; workingDirectory: string }): Promise<{ resolvedPath: string }> {
    const resolvedDir = path.resolve(params.workingDirectory);
    await this.ensureFolderTrusted(resolvedDir);
    const client = await this.readyClient();
    return client.changeWorkingDirectory({ sessionId: params.sessionId, workingDirectory: resolvedDir });
  }

  /**
   * Forks `params.sessionId` into an independent `newSessionId`.
   * Note: `daemon.fork_session` requires the source session to be loaded on the daemon and has no
   * `cwd` parameter of its own; when `params.cwd` is supplied (forking into a new worktree), this
   * trusts `params.cwd`, loads `newSessionId`, and calls `daemon.change_working_directory`.
   */
  async forkSession(params: LocalForkSessionParams): Promise<LocalForkSessionResult> {
    const client = await this.readyClient();
    const wasLoaded = this.loadedSessions.has(params.sessionId);
    let loadedTemporarily = false;
    if (!wasLoaded) {
      const opened = await this.listOpenedSessions();
      if (!opened.some((s) => s.sessionId === params.sessionId)) {
        await this.loadSession({ sessionId: params.sessionId });
        loadedTemporarily = true;
      }
    }
    let newSessionId: string;
    try {
      const res = await client.forkSession({
        sessionId: params.sessionId,
        ...(params.title !== undefined ? { title: params.title } : {}),
        ...(params.tags !== undefined ? { tags: params.tags } : {}),
      });
      newSessionId = res.newSessionId;
    } finally {
      if (loadedTemporarily && params.closeUnownedSource !== false) {
        await this.closeSession(params.sessionId).catch(() => {});
      }
    }

    if (!params.cwd && !params.loadOptions) {
      return { newSessionId };
    }
    const snapshot = await this.loadSession({ sessionId: newSessionId, ...(params.loadOptions ?? {}) });
    if (!params.cwd) {
      return { newSessionId, snapshot };
    }
    const { resolvedPath } = await this.changeWorkingDirectory({ sessionId: newSessionId, workingDirectory: params.cwd });
    return { newSessionId, resolvedCwd: resolvedPath, snapshot };
  }

  /** Lists skills available to `sessionId` in its current workspace. */
  async listSkills(sessionId: string) {
    const client = await this.readyClient();
    return client.listSkills({ sessionId });
  }

  /** Lists custom slash commands available to `sessionId` in its current workspace. */
  async listCommands(sessionId: string) {
    const client = await this.readyClient();
    return client.listCommands({ sessionId });
  }

  /** Combined user-invocable skills and custom commands formatted for `GET /api/agents/droid/commands`. */
  async listSlashCommands(sessionId: string): Promise<DroidSlashCommand[]> {
    const [commandsRes, skillsRes] = await Promise.all([this.listCommands(sessionId), this.listSkills(sessionId)]);
    const out: DroidSlashCommand[] = [];
    for (const cmd of commandsRes.commands) {
      if (!cmd.name) continue;
      out.push({
        name: cmd.name,
        description: cmd.description ?? '',
        source: 'command',
        ...(cmd.argumentHint ? { argumentHint: cmd.argumentHint } : {}),
      });
    }
    for (const skill of skillsRes.skills) {
      if (!skill.name || skill.enabled === false || skill.userInvocable === false) continue;
      out.push({
        name: skill.name,
        description: skill.description ?? '',
        source: 'skill',
      });
    }
    return out;
  }

  /** Lists available Droid models from the daemon. */
  async listModels() {
    const client = await this.readyClient();
    return client.listModels({});
  }

  private currentAirgapped(): boolean {
    if (this.airgappedOverride !== undefined) return this.airgappedOverride;
    if (this.opts.airgapped) return this.opts.airgapped();
    return Boolean(readSetupFile(this.opts.dataDir)?.airgapped);
  }

  private resolveDroidBinary(): string | null {
    const cmd = typeof this.opts.agentCmd === 'function' ? this.opts.agentCmd() : (this.opts.agentCmd ?? 'droid');
    return this.resolveDroid(cmd);
  }

  private sameToken(a: LocalDaemonAuth | undefined, b: LocalDaemonAuth): boolean {
    return Boolean(a && a.kind === b.kind && a.token === b.token && a.fingerprint === b.fingerprint);
  }

  private requireToken(): string {
    if (!this.activeAuth?.token) throw new Error('LocalDaemon is not authenticated');
    return this.activeAuth.token;
  }

  private async readyClient(): Promise<LocalDaemonSdkClient> {
    await this.ensureStarted();
    if (!this.client?.isConnected()) {
      throw new Error('LocalDaemon WebSocket client is not connected');
    }
    return this.client;
  }

  private makeClient(auth: LocalDaemonAuth): LocalDaemonSdkClient {
    if (this.opts.createClient) return this.opts.createClient(auth);
    return createWebSocketDaemonClient({
      machineType: MachineType.Local,
      getCredential: async () => (auth.kind === 'api-key' ? { apiKey: auth.apiKey } : { token: auth.token }),
      ...(auth.kind === 'workos' && auth.activeOrganizationId ? { getActiveOrganizationId: async () => auth.activeOrganizationId ?? null } : {}),
      clientSurface: 'sdk',
      requestTimeout: this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      transportConfig: {
        maxConnectRetries: 0,
        initialRetryDelayMs: 0,
        maxRetryDelayMs: 0,
        connectionTimeoutMs: Math.min(10_000, this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS),
      },
    });
  }

  private async startOrAttach(droidPath: string, airgapped: boolean, auth: LocalDaemonAuth): Promise<void> {
    this.detaching = true;
    this.closeClient();
    this.detaching = false;

    const persisted = readPersistedDaemonInfo(this.stateFile);
    if (persisted) {
      const alive = this.isPidAlive(persisted.pid);
      const compatible = alive && persisted.droidPath === droidPath && persisted.airgapped === airgapped && (!persisted.authFingerprint || persisted.authFingerprint === auth.fingerprint);
      if (compatible) {
        const attached = await this.tryConnectOnce(persisted, auth);
        if (attached) {
          if (!persisted.authFingerprint) {
            const updated: PersistedDaemonInfo = { ...persisted, authFingerprint: auth.fingerprint };
            writePrivateJson(this.stateFile, updated);
            this.activeDaemon = updated;
          }
          return;
        }
      }
      if (alive) this.killPid(persisted.pid, 'SIGTERM');
      this.removeStateFile();
    }

    const port = await this.pickPort();
    const baseEnv = this.env();
    const daemonEnv: Record<string, string> = {
      ...baseEnv,
      TERM: 'xterm-256color',
      FACTORY_MACHINE_TYPE: 'local',
      FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
      DISABLE_AUTO_UPDATE: 'true',
    };
    if (airgapped) {
      daemonEnv.FACTORY_AIRGAP_ENABLED = '1';
      delete daemonEnv.FACTORY_API_KEY;
    } else {
      delete daemonEnv.FACTORY_AIRGAP_ENABLED;
      if (auth.kind === 'api-key') daemonEnv.FACTORY_API_KEY = auth.apiKey;
      else delete daemonEnv.FACTORY_API_KEY;
    }

    const args = ['daemon', '--port', String(port), '--host', '127.0.0.1'];
    const child = this.spawnDaemon(droidPath, args, daemonEnv, this.logFile);
    child.unref();
    if (!child.pid) throw new Error('Failed to spawn detached droid daemon (missing PID)');

    let earlyExitError: Error | undefined;
    child.once('error', (err) => {
      earlyExitError = err instanceof Error ? err : new Error(String(err));
    });
    child.once('exit', (code, signal) => {
      earlyExitError = new Error(`droid daemon exited early (code=${String(code)}, signal=${String(signal)})`);
    });

    const recordInfo: PersistedDaemonInfo = {
      pid: child.pid,
      port,
      droidPath,
      airgapped,
      authFingerprint: auth.fingerprint,
      startedAt: this.now(),
    };
    writePrivateJson(this.stateFile, recordInfo);

    const timeoutMs = this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const deadline = this.now() + timeoutMs;
    let delayMs = this.opts.pollIntervalMs ?? 60;
    let lastError: unknown;

    while (!this.stopped && this.now() <= deadline) {
      if (earlyExitError) {
        this.removeStateFile();
        throw earlyExitError;
      }
      try {
        await this.connectAndAuthenticate(recordInfo, auth);
        return;
      } catch (err) {
        lastError = err;
        if (earlyExitError) {
          this.removeStateFile();
          throw earlyExitError;
        }
        if (this.now() + delayMs > deadline) break;
        await this.sleep(delayMs);
        delayMs = Math.min(250, Math.round(delayMs * 1.5));
      }
    }

    this.killPid(child.pid, 'SIGTERM');
    this.removeStateFile();
    throw new Error(`Timed out connecting to droid daemon on 127.0.0.1:${port}${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
  }

  private async tryConnectOnce(daemon: PersistedDaemonInfo, auth: LocalDaemonAuth): Promise<boolean> {
    try {
      await this.connectAndAuthenticate(daemon, auth);
      return true;
    } catch {
      return false;
    }
  }

  private async connectAndAuthenticate(daemon: PersistedDaemonInfo, auth: LocalDaemonAuth): Promise<void> {
    const client = this.makeClient(auth);
    this.wireClientHandlers(client);
    try {
      await client.connect(`ws://127.0.0.1:${daemon.port}`);
      await client.authenticate({
        ...(auth.kind === 'api-key'
          ? { apiKey: auth.apiKey }
          : {
              token: auth.token,
              ...(auth.kind === 'workos' && auth.activeOrganizationId ? { activeOrganizationId: auth.activeOrganizationId } : {}),
            }),
        caller: 'sdk',
        metadata: { sdk: { language: 'typescript', version: SDK_VERSION } },
      });
      this.client = client;
      this.activeDaemon = daemon;
      this.activeAuth = auth;
    } catch (err) {
      try {
        client.disconnect();
        client.destroy();
      } catch {
        // ignore cleanup error
      }
      throw err;
    }
  }

  private wireClientHandlers(client: LocalDaemonSdkClient): void {
    const onDisconnect = () => {
      if (this.client !== client) return;
      this.client = undefined;
      this.loadedSessions.clear();
      this.trustedFolders.clear();
      if (!this.detaching && !this.stopped) {
        for (const listener of this.connectionLostListeners) listener();
      }
    };
    client.onConnectionClose(onDisconnect);
    client.onConnectionError(() => {
      if (this.client === client && !client.isConnected()) onDisconnect();
    });
    client.onTransportMessage((raw) => {
      if (this.client && this.client !== client) return;
      const msg = record(raw);
      const method = typeof msg.method === 'string' ? msg.method : '';
      const params = record(msg.params);

      // Belt-and-suspenders: auto-approve every incoming permission / spec-handoff confirmation immediately.
      if (msg.type === 'request' && (method === DaemonDroidEvent.REQUEST_PERMISSION || method === 'droid.request_permission') && typeof msg.id === 'string') {
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
        const selectedOption = pickPermissionApprovalOption(params.options);
        client.sendPermissionResponse(msg.id, { sessionId, selectedOption });
        return;
      }

      if (msg.type === 'request' && (method === DaemonDroidEvent.ASK_USER || method === 'droid.ask_user') && typeof params.sessionId === 'string') {
        const ask = cloudAsk(msg.id, params);
        if (ask) {
          this.pendingAsks.set(params.sessionId, ask);
          this.emitAskUser({ sessionId: params.sessionId, ask });
        }
        return;
      }

      if (msg.type === 'notification' && method === DaemonDroidEvent.SESSION_NOTIFICATION && typeof params.sessionId === 'string') {
        const notification = record(params.notification);
        const type = typeof notification.type === 'string' ? notification.type : '';
        if (!type) return;
        if (['session_process_exited', 'session_inactivity', 'session_closed', 'session_unsubscribed'].includes(type)) {
          this.loadedSessions.delete(params.sessionId);
        }
        const typedNotification: LocalDaemonNotification = { ...notification, type };
        const event: LocalSessionNotificationEvent = { sessionId: params.sessionId, notification: typedNotification };
        for (const listener of this.notificationListeners) listener(event);
        const scoped = this.sessionListeners.get(params.sessionId);
        if (scoped) for (const listener of scoped) listener(typedNotification);
      }
    });
  }

  private autoApproveSnapshotPermissions(client: LocalDaemonSdkClient, sessionId: string, pendingPermissions: unknown): void {
    if (!Array.isArray(pendingPermissions)) return;
    for (const item of pendingPermissions) {
      const p = record(item);
      const requestId = typeof p.requestId === 'string' ? p.requestId : typeof p.id === 'string' ? p.id : '';
      if (!requestId) continue;
      const selectedOption = pickPermissionApprovalOption(p.options);
      client.sendPermissionResponse(requestId, { sessionId, selectedOption });
    }
  }

  private syncSnapshotAskUser(sessionId: string, pendingAskUserRequests: unknown): void {
    const list = Array.isArray(pendingAskUserRequests) ? pendingAskUserRequests : [];
    const latest = list.length ? record(list.at(-1)) : undefined;
    const ask = latest ? cloudAsk(latest.requestId ?? latest.id, latest) : undefined;
    if (ask) this.pendingAsks.set(sessionId, ask);
    else this.pendingAsks.delete(sessionId);
    this.emitAskUser({ sessionId, ask });
  }

  private emitAskUser(event: LocalAskUserEvent): void {
    for (const listener of this.askListeners) listener(event);
  }

  private killDaemonInstance(daemon: PersistedDaemonInfo): void {
    this.detaching = true;
    try {
      this.closeClient();
      this.activeDaemon = undefined;
      this.killPid(daemon.pid, 'SIGTERM');
      this.removeStateFile();
    } finally {
      this.detaching = false;
    }
  }

  private closeClient(): void {
    const client = this.client;
    this.client = undefined;
    this.loadedSessions.clear();
    this.trustedFolders.clear();
    if (!client) return;
    try {
      client.disconnect();
      client.destroy();
    } catch {
      // ignore disconnect errors
    }
  }

  private removeStateFile(): void {
    try {
      rmSync(this.stateFile, { force: true });
    } catch {
      // already gone
    }
  }
}
