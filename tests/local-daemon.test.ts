import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { AutonomyLevel, DroidInteractionMode, FACTORY_PROTOCOL_VERSION, JSONRPC_VERSION, LEGACY_FACTORY_API_VERSION, SDK_VERSION, ToolConfirmationOutcome } from '@factory/droid-sdk';
import {
  AIRGAPPED_DAEMON_TOKEN,
  buildOfficeMcpServers,
  decryptFactoryAuthV2,
  isJwtExpired,
  LocalDaemon,
  pickFreeLoopbackPort,
  pickPermissionApprovalOption,
  QueuePlacement,
  readFactoryWorkOsAuth,
  type LocalAskUserEvent,
  type LocalDaemonAuth,
  type LocalDaemonSdkClient,
  type LocalSessionNotificationEvent,
  type SpawnedDaemonProcess,
} from '../src/server/local-daemon.js';

function encryptAuthV2(payload: Record<string, unknown>, key: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function makeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${body}.sig`;
}

class FakeChild extends EventEmitter implements SpawnedDaemonProcess {
  unreffed = false;
  constructor(readonly pid: number) {
    super();
  }
  unref(): void {
    this.unreffed = true;
  }
}

class FakeDaemonClient implements LocalDaemonSdkClient {
  connected = false;
  destroyed = false;
  disconnectedCount = 0;
  urls: string[] = [];
  authCalls: unknown[] = [];
  initCalls: Record<string, unknown>[] = [];
  loadCalls: Record<string, unknown>[] = [];
  addMessageCalls: { params: Record<string, unknown>; requestId?: string }[] = [];
  resolveQueueCalls: Record<string, unknown>[] = [];
  settingsCalls: Record<string, unknown>[] = [];
  trustChecks: string[] = [];
  trustedPaths: string[] = [];
  cwdCalls: Record<string, unknown>[] = [];
  forkCalls: Record<string, unknown>[] = [];
  compactCalls: Record<string, unknown>[] = [];
  rewindInfoCalls: Record<string, unknown>[] = [];
  executeRewindCalls: Record<string, unknown>[] = [];
  interruptCalls: Record<string, unknown>[] = [];
  closeCalls: Record<string, unknown>[] = [];
  permissionResponses: { requestId: string; result: Record<string, unknown> }[] = [];
  askUserResponses: { requestId: string; result: Record<string, unknown> }[] = [];

  connectFailuresRemaining = 0;
  folderTrusted = false;
  openedSessions: { sessionId: string; updatedAt: number; workingState: string }[] = [];
  loadSnapshot: Record<string, unknown> = {
    settings: { modelId: 'claude-sonnet-4-6', reasoningEffort: 'high', interactionMode: 'auto', autonomyLevel: 'high' },
    session: { messages: [] },
  };
  nextForkSessionId = 'ses-forked-1';

  private transportHandler: (msg: unknown) => void = () => {};
  private closeHandler: (code: number, reason: string) => void = () => {};
  private errorHandler: (error: Error) => void = () => {};

  async connect(url: string): Promise<void> {
    this.urls.push(url);
    if (this.connectFailuresRemaining > 0) {
      this.connectFailuresRemaining--;
      throw new Error('connect ECONNREFUSED 127.0.0.1');
    }
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
    this.disconnectedCount++;
  }

  destroy(): void {
    this.destroyed = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async authenticate(params: unknown): Promise<{ userId: string; orgId: string }> {
    this.authCalls.push(params);
    return { userId: 'usr-1', orgId: 'org-1' };
  }

  async initializeSession(params: unknown): Promise<any> {
    const p = params as Record<string, unknown>;
    this.initCalls.push(p);
    return {
      sessionId: (p.sessionId as string | undefined) ?? 'ses-init-1',
      settings: {
        modelId: p.modelId ?? 'claude-sonnet-4-6',
        reasoningEffort: p.reasoningEffort ?? 'high',
        interactionMode: p.interactionMode,
        autonomyLevel: p.autonomyLevel,
      },
      session: { messages: [] },
    };
  }

  async loadSession(params: unknown): Promise<any> {
    const p = params as Record<string, unknown>;
    this.loadCalls.push(p);
    return structuredClone(this.loadSnapshot);
  }

  async addUserMessage(params: unknown, requestId?: string): Promise<Record<string, never>> {
    this.addMessageCalls.push({ params: params as Record<string, unknown>, requestId });
    return {};
  }

  async resolveQueuedUserMessage(params: unknown): Promise<Record<string, never>> {
    this.resolveQueueCalls.push(params as Record<string, unknown>);
    return {};
  }

  async interruptSession(params: unknown): Promise<Record<string, never>> {
    this.interruptCalls.push(params as Record<string, unknown>);
    return {};
  }

  async closeSession(params: unknown): Promise<Record<string, never>> {
    this.closeCalls.push(params as Record<string, unknown>);
    return {};
  }

  async listOpenedSessions(): Promise<any> {
    return { sessions: this.openedSessions };
  }

  async updateSessionSettings(params: unknown): Promise<Record<string, never>> {
    this.settingsCalls.push(params as Record<string, unknown>);
    return {};
  }

  async changeWorkingDirectory(params: unknown): Promise<{ resolvedPath: string }> {
    const p = params as { sessionId: string; workingDirectory: string };
    this.cwdCalls.push(p);
    return { resolvedPath: p.workingDirectory };
  }

  async checkFolderTrust(params: unknown): Promise<{ isTrusted: boolean; trustRootPath: string; promptRequired: boolean }> {
    const p = params as { path: string };
    this.trustChecks.push(p.path);
    return { isTrusted: this.folderTrusted, trustRootPath: p.path, promptRequired: !this.folderTrusted };
  }

  async trustFolder(params: unknown): Promise<{ trustRootPath: string }> {
    const p = params as { path: string };
    this.trustedPaths.push(p.path);
    this.folderTrusted = true;
    return { trustRootPath: p.path };
  }

  async getRewindInfo(params: unknown): Promise<any> {
    this.rewindInfoCalls.push(params as Record<string, unknown>);
    return {
      availableFiles: [{ filePath: 'src/a.ts', contentHash: 'abc123', size: 42 }],
      createdFiles: [{ filePath: 'src/new.ts' }],
      evictedFiles: [],
    };
  }

  async executeRewind(params: unknown): Promise<any> {
    this.executeRewindCalls.push(params as Record<string, unknown>);
    return {
      newSessionId: 'ses-rewound-2',
      restoredCount: 1,
      deletedCount: 1,
      failedRestoreCount: 0,
      failedDeleteCount: 0,
    };
  }

  async compactSession(params: unknown): Promise<any> {
    const p = params as { sessionId: string; mode?: 'handoff' };
    this.compactCalls.push(p);
    return {
      newSessionId: p.mode === 'handoff' ? 'ses-handoff-2' : p.sessionId,
      removedCount: 12,
    };
  }

  async forkSession(params: unknown): Promise<{ newSessionId: string }> {
    this.forkCalls.push(params as Record<string, unknown>);
    return { newSessionId: this.nextForkSessionId };
  }

  async listSkills(): Promise<any> {
    return {
      skills: [
        { name: 'review-pr', filePath: '/repo/.agents/skills/review-pr/SKILL.md', location: 'project', description: 'Review PR', enabled: true, userInvocable: true },
        { name: 'disabled-skill', filePath: '/repo/.agents/skills/disabled/SKILL.md', location: 'project', description: 'Disabled', enabled: false, userInvocable: true },
        { name: 'internal-only', filePath: '/repo/.agents/skills/internal/SKILL.md', location: 'project', description: 'Internal', enabled: true, userInvocable: false },
      ],
    };
  }

  async listCommands(): Promise<any> {
    return {
      commands: [{ name: 'ship', description: 'Ship release', argumentHint: '[tag]', isExecutable: true }],
    };
  }

  async listModels(): Promise<any> {
    return { models: [{ id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', shortDisplayName: 'Sonnet', supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'high', isCustom: false }] };
  }

  sendPermissionResponse(requestId: string, result: unknown): void {
    this.permissionResponses.push({ requestId, result: result as Record<string, unknown> });
  }

  sendAskUserResponse(requestId: string, result: unknown): void {
    this.askUserResponses.push({ requestId, result: result as Record<string, unknown> });
  }

  onTransportMessage(handler: (message: unknown) => void): void {
    this.transportHandler = handler;
  }

  onConnectionClose(handler: (code: number, reason: string) => void): () => void {
    this.closeHandler = handler;
    return () => {
      if (this.closeHandler === handler) this.closeHandler = () => {};
    };
  }

  onConnectionError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  emitTransport(message: unknown): void {
    this.transportHandler(message);
  }

  simulateUnexpectedDrop(): void {
    this.connected = false;
    this.errorHandler(new Error('socket hang up'));
    this.closeHandler(1006, 'abnormal closure');
  }
}

function makeTempWorkspace(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'droid-office-local-daemon-'));
  const dataDir = path.join(root, '.droid-office');
  const home = path.join(root, 'home');
  const repoDir = path.join(root, 'repo');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(path.join(home, '.factory'), { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, dataDir, home, repoDir };
}

test('decryptFactoryAuthV2 and readFactoryWorkOsAuth prioritize macOS Keychain over stale auth.v2.file and validate AES-256-GCM', async (t) => {
  const { home } = makeTempWorkspace(t);
  const keychainKey = randomBytes(32);
  const fileKey = randomBytes(32);
  const freshJwt = makeJwt({ sub: 'user-fresh', exp: Math.floor(Date.now() / 1000) + 3600 });
  const staleJwt = makeJwt({ sub: 'user-stale', exp: Math.floor(Date.now() / 1000) - 7200 });

  writeFileSync(path.join(home, '.factory', 'auth.v2.loginkeychain'), encryptAuthV2({ access_token: freshJwt, refresh_token: 'rt-fresh', active_organization_id: 'org-mac' }, keychainKey));
  writeFileSync(path.join(home, '.factory', 'auth.v2.key'), fileKey.toString('base64'));
  writeFileSync(path.join(home, '.factory', 'auth.v2.file'), encryptAuthV2({ access_token: staleJwt, refresh_token: 'rt-stale', active_organization_id: 'org-file' }, fileKey));

  // macOS reads auth.v2.loginkeychain first
  const darwinCreds = await readFactoryWorkOsAuth({
    home,
    platform: 'darwin',
    readKeychainKey: async () => `${keychainKey.toString('base64')}\n`,
  });
  assert.equal(darwinCreds?.access_token, freshJwt);
  assert.equal(darwinCreds?.active_organization_id, 'org-mac');

  // Falls back to auth.v2.file when Keychain is disabled or unavailable
  const fallbackCreds = await readFactoryWorkOsAuth({
    home,
    platform: 'darwin',
    disableKeyring: true,
    readKeychainKey: async () => `${keychainKey.toString('base64')}\n`,
  });
  assert.equal(fallbackCreds?.access_token, staleJwt);
  assert.equal(fallbackCreds?.active_organization_id, 'org-file');

  const linuxCreds = await readFactoryWorkOsAuth({ home, platform: 'linux' });
  assert.equal(linuxCreds?.access_token, staleJwt);

  // Rejects invalid key sizes, malformed ciphertexts, and tampered auth tags
  assert.throws(() => decryptFactoryAuthV2('bad', keychainKey), /Invalid encrypted Factory auth format/);
  assert.throws(() => decryptFactoryAuthV2('a:b:c', Buffer.alloc(16)), /Invalid Factory auth key length/);
  const validCipher = encryptAuthV2({ access_token: freshJwt }, keychainKey);
  const [iv, , body] = validCipher.split(':');
  const wrongTag = randomBytes(16).toString('base64');
  assert.throws(() => decryptFactoryAuthV2(`${iv}:${wrongTag}:${body}`, keychainKey));
  assert.equal(isJwtExpired(freshJwt, Date.now()), false);
  assert.equal(isJwtExpired(staleJwt, Date.now()), true);
});

test('refreshes expired WorkOS JWT via refreshWorkOsAuth before authenticating, and prefers fk-* API key when configured', async (t) => {
  const { dataDir, home } = makeTempWorkspace(t);
  const fileKey = randomBytes(32);
  const now = 1_700_000_000_000;
  const expiredJwt = makeJwt({ sub: 'u1', exp: Math.floor(now / 1000) - 10 });
  const refreshedJwt = makeJwt({ sub: 'u1', exp: Math.floor(now / 1000) + 3600 });

  writeFileSync(path.join(home, '.factory', 'auth.v2.key'), fileKey.toString('base64'));
  writeFileSync(path.join(home, '.factory', 'auth.v2.file'), encryptAuthV2({ access_token: expiredJwt, active_organization_id: 'org-9' }, fileKey));

  let refreshRuns = 0;
  let configuredKey: string | undefined;
  const daemon = new LocalDaemon({
    dataDir,
    home,
    platform: 'linux',
    now: () => now,
    env: () => ({ PATH: '/usr/bin' }),
    resolveDroidPath: () => '/usr/local/bin/droid',
    apiKey: () => configuredKey,
    refreshWorkOsAuth: async (droidPath) => {
      assert.equal(droidPath, '/usr/local/bin/droid');
      refreshRuns++;
      writeFileSync(path.join(home, '.factory', 'auth.v2.file'), encryptAuthV2({ access_token: refreshedJwt, active_organization_id: 'org-9' }, fileKey));
    },
  });

  const workosAuth = await daemon.resolveAuth();
  assert.equal(refreshRuns, 1);
  assert.deepEqual(workosAuth, {
    kind: 'workos',
    token: refreshedJwt,
    activeOrganizationId: 'org-9',
    fingerprint: 'workos',
  });

  configuredKey = 'fk-live-office-key-999';
  const keyAuth = await daemon.resolveAuth();
  assert.equal(keyAuth.kind, 'api-key');
  assert.equal(keyAuth.token, 'fk-live-office-key-999');
  assert.match(keyAuth.fingerprint, /^api-key:[0-9a-f]{16}$/);
});

test('spawns detached droid daemon without --parent-pid, polls cold start, persists 0600 droid-daemon.json, and toggles airgap cleanly', async (t) => {
  const { dataDir, home } = makeTempWorkspace(t);
  writeFileSync(path.join(dataDir, 'setup.json'), JSON.stringify({ onboarded: true, airgapped: true }));

  const spawned: { droidPath: string; args: string[]; env: Record<string, string>; pid: number; child: FakeChild }[] = [];
  const alivePids = new Set<number>();
  const killed: { pid: number; signal?: string }[] = [];
  const clients: FakeDaemonClient[] = [];
  let nextPid = 4100;
  let nextPort = 52100;
  let clock = 10_000;

  const daemon = new LocalDaemon({
    dataDir,
    home,
    platform: 'darwin',
    apiKey: () => 'fk-should-not-leak-in-airgap',
    env: () => ({ PATH: '/usr/bin' }),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    resolveDroidPath: () => '/opt/bin/droid',
    pickPort: async () => nextPort++,
    isPidAlive: (pid) => alivePids.has(pid),
    killPid: (pid, signal) => {
      alivePids.delete(pid);
      killed.push({ pid, signal });
    },
    spawnDaemon: (droidPath, args, env) => {
      const pid = nextPid++;
      alivePids.add(pid);
      const child = new FakeChild(pid);
      spawned.push({ droidPath, args, env, pid, child });
      return child;
    },
    createClient: (_auth: LocalDaemonAuth) => {
      const c = new FakeDaemonClient();
      if (clients.length === 0) c.connectFailuresRemaining = 1;
      clients.push(c);
      return c;
    },
  });

  await daemon.ensureStarted();
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, ['daemon', '--port', '52100', '--host', '127.0.0.1']);
  assert.equal(spawned[0].args.includes('--parent-pid'), false);
  assert.equal(spawned[0].args.includes('--liveness-fd'), false);
  assert.equal(spawned[0].child.unreffed, true);
  assert.equal(spawned[0].env.FACTORY_AIRGAP_ENABLED, '1');
  assert.equal(spawned[0].env.FACTORY_API_KEY, undefined);
  assert.equal(spawned[0].env.FACTORY_DROID_AUTO_UPDATE_ENABLED, 'false');

  // Cold-start retry created 2 client attempts (first ECONNREFUSED, second connected)
  assert.equal(clients.length, 2);
  assert.deepEqual(clients[1].authCalls[0], {
    token: AIRGAPPED_DAEMON_TOKEN,
    caller: 'sdk',
    metadata: { sdk: { language: 'typescript', version: SDK_VERSION } },
  });

  // Persisted droid-daemon.json has 0600 permissions and exact metadata
  const statePath = path.join(dataDir, 'droid-daemon.json');
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(persisted.pid, 4100);
  assert.equal(persisted.port, 52100);
  assert.equal(persisted.droidPath, '/opt/bin/droid');
  assert.equal(persisted.airgapped, true);

  // Toggling airgapped off kills PID 4100 and restarts with fk-* API key
  await daemon.setAirgapped(false);
  assert.deepEqual(killed, [{ pid: 4100, signal: 'SIGTERM' }]);
  assert.equal(spawned.length, 2);
  assert.equal(spawned[1].env.FACTORY_AIRGAP_ENABLED, undefined);
  assert.equal(spawned[1].env.FACTORY_API_KEY, 'fk-should-not-leak-in-airgap');
  assert.deepEqual(clients.at(-1)?.authCalls[0], {
    apiKey: 'fk-should-not-leak-in-airgap',
    caller: 'sdk',
    metadata: { sdk: { language: 'typescript', version: SDK_VERSION } },
  });
  const persistedAfterToggle = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(persistedAfterToggle.pid, 4101);
  assert.equal(persistedAfterToggle.airgapped, false);
});

test('SIGTERM disconnect leaves daemon alive for adoption on restart, while SIGINT stop kills daemon PID', async (t) => {
  const { dataDir, home } = makeTempWorkspace(t);
  const alivePids = new Set<number>();
  const killed: number[] = [];
  let spawnCount = 0;
  const activeClient = new FakeDaemonClient();
  activeClient.openedSessions = [
    { sessionId: 'ses-live-1', updatedAt: 100, workingState: 'executing_tool' },
    { sessionId: 'ses-live-2', updatedAt: 200, workingState: 'waiting_for_tool_confirmation' },
  ];
  activeClient.loadSnapshot = {
    settings: { modelId: 'claude-sonnet-4-6', reasoningEffort: 'high', interactionMode: 'spec', autonomyLevel: 'low' },
    session: { messages: [] },
    pendingPermissions: [
      {
        requestId: 'perm-snap-1',
        options: [
          { label: 'Proceed in auto mode', value: ToolConfirmationOutcome.ProceedAutoRunHigh },
          { label: 'Cancel', value: ToolConfirmationOutcome.Cancel },
        ],
      },
    ],
    pendingAskUserRequests: [
      {
        requestId: 'ask-snap-1',
        toolCallId: 'tc-ask-1',
        questions: [{ index: 1, header: 'Scope', question: 'Which target?', options: ['Web', 'Android'], multiSelect: false }],
      },
    ],
  };

  const signals = new EventEmitter();
  const firstOffice = new LocalDaemon({
    dataDir,
    home,
    apiKey: () => 'fk-restart-key',
    env: () => ({ PATH: '/usr/bin' }),
    resolveDroidPath: () => '/opt/bin/droid',
    pickPort: async () => 53111,
    isPidAlive: (pid) => alivePids.has(pid),
    killPid: (pid) => {
      alivePids.delete(pid);
      killed.push(pid);
    },
    spawnDaemon: () => {
      spawnCount++;
      alivePids.add(7777);
      return new FakeChild(7777);
    },
    createClient: () => activeClient,
  });

  const unbindFirst = firstOffice.bindProcessSignals(signals as unknown as NodeJS.Process);
  let unexpectedLost = 0;
  firstOffice.onConnectionLost(() => unexpectedLost++);

  await firstOffice.ensureStarted();
  assert.equal(spawnCount, 1);

  // SIGTERM disconnects WS without killing PID 7777 or firing unexpected connection-lost
  signals.emit('SIGTERM');
  unbindFirst();
  assert.equal(firstOffice.isConnected(), false);
  assert.equal(alivePids.has(7777), true);
  assert.deepEqual(killed, []);
  assert.equal(unexpectedLost, 0);
  assert.equal(existsSync(path.join(dataDir, 'droid-daemon.json')), true);

  // Second Office starts up, reconnects to PID 7777 WITHOUT spawning, and adopts saved sessions
  const reattachedClient = new FakeDaemonClient();
  reattachedClient.openedSessions = activeClient.openedSessions;
  reattachedClient.loadSnapshot = activeClient.loadSnapshot;

  const secondOffice = new LocalDaemon({
    dataDir,
    home,
    apiKey: () => 'fk-restart-key',
    env: () => ({ PATH: '/usr/bin' }),
    resolveDroidPath: () => '/opt/bin/droid',
    isPidAlive: (pid) => alivePids.has(pid),
    killPid: (pid) => {
      alivePids.delete(pid);
      killed.push(pid);
    },
    spawnDaemon: () => {
      spawnCount++;
      return new FakeChild(8888);
    },
    createClient: () => reattachedClient,
  });

  const asks: LocalAskUserEvent[] = [];
  secondOffice.onAskUser((ev) => asks.push(ev));

  const adopted = await secondOffice.adoptSessions([
    {
      sessionId: 'ses-live-1',
      mcp: { hookUrl: 'http://127.0.0.1:4655/', workerHookToken: 'tok-w1', workerId: 'w1' },
      denyTask: true,
    },
  ]);

  assert.equal(spawnCount, 1, 'must reuse live persisted daemon without spawning a second process');
  assert.deepEqual(adopted.openedSessionIds, ['ses-live-1', 'ses-live-2']);
  assert.equal(adopted.adopted.has('ses-live-1'), true);
  assert.equal(adopted.failed.size, 0);

  // Snapshot settings were upgraded to interactionMode: 'auto', autonomyLevel: 'high'
  assert.deepEqual(reattachedClient.settingsCalls[0], {
    sessionId: 'ses-live-1',
    interactionMode: DroidInteractionMode.Auto,
    autonomyLevel: AutonomyLevel.High,
    disabledToolIds: ['Task'],
  });
  // Snapshot pending permission was auto-approved with first non-cancel option
  assert.deepEqual(reattachedClient.permissionResponses, [
    {
      requestId: 'perm-snap-1',
      result: { sessionId: 'ses-live-1', selectedOption: ToolConfirmationOutcome.ProceedAutoRunHigh },
    },
  ]);
  // Snapshot pending AskUser was surfaced
  assert.equal(asks.length, 1);
  assert.equal(asks[0].sessionId, 'ses-live-1');
  assert.equal(asks[0].ask?.requestId, 'ask-snap-1');
  assert.equal(secondOffice.pendingAsk('ses-live-1')?.questions[0]?.question, 'Which target?');

  // SIGINT ("Quit and Stop Workers") kills PID 7777 and removes droid-daemon.json
  const unbindSecond = secondOffice.bindProcessSignals(signals as unknown as NodeJS.Process);
  signals.emit('SIGINT');
  unbindSecond();
  assert.deepEqual(killed, [7777]);
  assert.equal(existsSync(path.join(dataDir, 'droid-daemon.json')), false);
});

test('initializeSession, MCP omit-oauth, Task denial, permission auto-approval, queue, rewind, compact/handoff, fork+cwd, and events', async (t) => {
  const { dataDir, home, repoDir } = makeTempWorkspace(t);
  const worktreeDir = path.join(repoDir, '.droid-office', 'worktrees', 'w2');
  mkdirSync(worktreeDir, { recursive: true });

  const client = new FakeDaemonClient();
  const daemon = new LocalDaemon({
    dataDir,
    home,
    apiKey: () => 'fk-session-test',
    env: () => ({ PATH: '/usr/bin' }),
    resolveDroidPath: () => '/opt/bin/droid',
    pickPort: async () => 54123,
    spawnDaemon: () => new FakeChild(9001),
    isPidAlive: () => true,
    killPid: () => {},
    createClient: () => client,
  });

  // 1. buildOfficeMcpServers omits `oauth` completely
  const mcpServers = buildOfficeMcpServers({
    hookUrl: 'http://127.0.0.1:4601/',
    workerHookToken: 'worker-secret',
    workerId: 'w1',
  });
  assert.equal(mcpServers?.length, 1);
  assert.equal('oauth' in mcpServers![0], false);
  assert.deepEqual(mcpServers![0], {
    type: 'http',
    name: 'droid-office',
    url: 'http://127.0.0.1:4601/office/mcp',
    headers: [
      { name: 'Authorization', value: 'Bearer worker-secret' },
      { name: 'x-droid-office-worker-id', value: 'w1' },
      { name: 'x-droid-office-url', value: 'http://127.0.0.1:4601' },
    ],
  });

  // 2. initializeSession trusts folder and passes exact autonomy, MCP (without oauth), disabledToolIds, and preset systemPrompt
  const created = await daemon.initializeSession({
    cwd: repoDir,
    modelId: 'claude-opus-4-7',
    reasoningEffort: 'xhigh',
    workerSystemPrompt: 'You are Ada on Floor 1.',
    mcp: { hookUrl: 'http://127.0.0.1:4601', workerHookToken: 'worker-secret', workerId: 'w1' },
    subagents: { officeMcp: true, denyTask: true },
  });
  assert.equal(created.sessionId, 'ses-init-1');
  assert.deepEqual(client.trustedPaths, [path.resolve(repoDir)]);
  const initCall = client.initCalls[0];
  assert.equal(initCall.skipPermissionsUnsafe, true);
  assert.equal(initCall.interactionMode, 'auto');
  assert.equal(initCall.autonomyLevel, 'high');
  assert.equal(initCall.disableInactivityTimeout, true);
  assert.deepEqual(initCall.disabledToolIds, ['Task']);
  assert.deepEqual(initCall.systemPrompt, { type: 'preset', preset: 'droid', append: 'You are Ada on Floor 1.' });
  const sentMcp = (initCall.mcpServers as Record<string, unknown>[])[0];
  assert.equal('oauth' in sentMcp, false);

  // 3. Belt-and-suspenders permission auto-approval (`proceed_once` preferred, else first non-cancel/non-proceed_edit)
  assert.equal(
    pickPermissionApprovalOption([
      { label: 'Cancel', value: 'cancel' },
      { label: 'Edit spec', value: 'proceed_edit' },
      { label: 'Proceed once', value: 'proceed_once' },
      { label: 'Always', value: 'proceed_always' },
    ]),
    ToolConfirmationOutcome.ProceedOnce,
  );
  assert.equal(
    pickPermissionApprovalOption([
      { label: 'Edit spec', value: 'proceed_edit' },
      { label: 'Start auto high', value: 'proceed_auto_run_high' },
      { label: 'Cancel', value: 'cancel' },
    ]),
    ToolConfirmationOutcome.ProceedAutoRunHigh,
  );

  client.emitTransport({
    type: 'request',
    id: 'perm-live-1',
    method: 'daemon.request_permission',
    params: {
      sessionId: 'ses-init-1',
      options: [
        { label: 'Proceed once', value: 'proceed_once' },
        { label: 'Cancel', value: 'cancel' },
      ],
      toolUses: [],
    },
  });
  client.emitTransport({
    type: 'request',
    id: 'perm-spec-2',
    method: 'droid.request_permission',
    params: {
      sessionId: 'ses-init-1',
      options: [
        { label: 'Edit', value: 'proceed_edit' },
        { label: 'Auto', value: 'proceed_auto_run' },
        { label: 'Cancel', value: 'cancel' },
      ],
      toolUses: [],
    },
  });
  assert.deepEqual(client.permissionResponses, [
    { requestId: 'perm-live-1', result: { sessionId: 'ses-init-1', selectedOption: 'proceed_once' } },
    { requestId: 'perm-spec-2', result: { sessionId: 'ses-init-1', selectedOption: 'proceed_auto_run' } },
  ]);

  // 4. addUserMessage (steering EndOfTurn vs queued EndOfLoop, base64/dataURL + file path images, requestId) + queue resolution
  const steer = await daemon.addUserMessage({
    sessionId: 'ses-init-1',
    text: 'Focus on auth first',
    queue: false,
    requestId: 'req-steer-1',
    images: ['data:image/png;base64,iVBORw0KGgo=', '/tmp/screenshot.webp'],
  });
  assert.equal(steer.requestId, 'req-steer-1');
  assert.deepEqual(client.addMessageCalls[0], {
    requestId: 'req-steer-1',
    params: {
      sessionId: 'ses-init-1',
      messageId: 'req-steer-1',
      text: 'Focus on auth first',
      queuePlacement: QueuePlacement.EndOfTurn,
      images: [{ type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' }],
      imagePaths: ['/tmp/screenshot.webp'],
    },
  });

  await daemon.addUserMessage({
    sessionId: 'ses-init-1',
    text: 'Run lint afterwards',
    queue: true,
    requestId: 'req-queued-2',
  });
  assert.equal(client.addMessageCalls[1].params.queuePlacement, QueuePlacement.EndOfLoop);

  await daemon.promoteQueuedMessage('ses-init-1', 'req-queued-2');
  await daemon.deleteQueuedMessage('ses-init-1', 'req-queued-2');
  assert.deepEqual(client.resolveQueueCalls, [
    { sessionId: 'ses-init-1', requestId: 'req-queued-2', action: 'update_queue', queuePlacement: QueuePlacement.EndOfTurn },
    { sessionId: 'ses-init-1', requestId: 'req-queued-2', action: 'delete' },
  ]);

  // 5. AskUser subscription + sendAskUserResponse
  const askEvents: LocalAskUserEvent[] = [];
  const offAsk = daemon.onAskUser((ev) => askEvents.push(ev));
  client.emitTransport({
    type: 'request',
    id: 'ask-live-9',
    method: 'daemon.ask_user',
    params: {
      sessionId: 'ses-init-1',
      toolCallId: 'tool-ask-9',
      questions: [{ index: 1, question: 'Deploy target?', options: ['Staging', 'Prod'], multiSelect: false }],
    },
  });
  assert.equal(askEvents.length, 1);
  assert.equal(askEvents[0].ask?.requestId, 'ask-live-9');
  assert.equal(
    daemon.sendAskUserResponse('ask-live-9', {
      sessionId: 'ses-init-1',
      answers: [{ index: 1, question: 'Deploy target?', answer: 'Staging' }],
    }),
    true,
  );
  assert.equal(daemon.pendingAsk('ses-init-1'), undefined);
  assert.equal(askEvents.at(-1)?.ask, undefined);
  offAsk();

  // 6. Settings, Rewind, Compact & Handoff, Skills & Commands
  await daemon.updateSessionSettings({ sessionId: 'ses-init-1', modelId: 'gpt-5.4', reasoningEffort: 'high' });
  assert.deepEqual(client.settingsCalls.at(-1), { sessionId: 'ses-init-1', modelId: 'gpt-5.4', reasoningEffort: 'high' });

  const rewindInfo = await daemon.getRewindInfo({ sessionId: 'ses-init-1', messageId: 'msg-3' });
  assert.equal(rewindInfo.availableFiles[0].filePath, 'src/a.ts');
  const rewound = await daemon.executeRewind({
    sessionId: 'ses-init-1',
    messageId: 'msg-3',
    filesToRestore: rewindInfo.availableFiles,
    filesToDelete: rewindInfo.createdFiles,
    forkTitle: 'Rewind',
  });
  assert.equal(rewound.newSessionId, 'ses-rewound-2');

  const compacted = await daemon.compactSession({ sessionId: 'ses-init-1', customInstructions: 'Keep API decisions' });
  assert.equal(compacted.newSessionId, 'ses-init-1');
  const handedOff = await daemon.compactSession({ sessionId: 'ses-init-1', mode: 'handoff' });
  assert.equal(handedOff.newSessionId, 'ses-handoff-2');

  const slash = await daemon.listSlashCommands('ses-init-1');
  assert.deepEqual(slash, [
    { name: 'ship', description: 'Ship release', source: 'command', argumentHint: '[tag]' },
    { name: 'review-pr', description: 'Review PR', source: 'skill' },
  ]);

  // 7. forkSession loads an unopened source session, forks, closes temporary source, trusts new worktree cwd, loads fork, and changes cwd
  client.folderTrusted = false;
  const forked = await daemon.forkSession({
    sessionId: 'ses-cold-source',
    title: 'Forked Worker',
    cwd: worktreeDir,
    loadOptions: { denyTask: true },
  });
  assert.equal(forked.newSessionId, 'ses-forked-1');
  assert.equal(forked.resolvedCwd, path.resolve(worktreeDir));
  assert.equal(
    client.loadCalls.some((c) => c.sessionId === 'ses-cold-source'),
    true,
  );
  assert.equal(
    client.closeCalls.some((c) => c.sessionId === 'ses-cold-source'),
    true,
  );
  assert.equal(client.trustedPaths.includes(path.resolve(worktreeDir)), true);
  assert.deepEqual(client.cwdCalls, [{ sessionId: 'ses-forked-1', workingDirectory: path.resolve(worktreeDir) }]);

  // 8. Session notifications (global + per-session) and unexpected connection loss
  const allNotes: LocalSessionNotificationEvent[] = [];
  const scopedNotes: string[] = [];
  const offAll = daemon.onSessionNotification((ev) => allNotes.push(ev));
  const offScoped = daemon.onSessionNotification('ses-init-1', (n) => scopedNotes.push(n.type));
  client.emitTransport({
    type: 'notification',
    method: 'daemon.session_notification',
    params: { sessionId: 'ses-init-1', notification: { type: 'assistant_text_delta', textDelta: 'hi' } },
  });
  client.emitTransport({
    type: 'notification',
    method: 'daemon.session_notification',
    params: { sessionId: 'other-session', notification: { type: 'thinking_text_delta', textDelta: 'hmm' } },
  });
  assert.equal(allNotes.length, 2);
  assert.deepEqual(scopedNotes, ['assistant_text_delta']);
  offAll();
  offScoped();

  let lostCount = 0;
  daemon.onConnectionLost(() => lostCount++);
  client.simulateUnexpectedDrop();
  assert.equal(lostCount, 1);
  assert.equal(daemon.isConnected(), false);
});

test('real @factory/droid-sdk createWebSocketDaemonClient wire round-trip over loopback WebSocketServer', async (t) => {
  const { dataDir, home, repoDir } = makeTempWorkspace(t);
  const port = await pickFreeLoopbackPort();
  assert.equal(port !== 37643 && port !== 41723, true);

  const receivedRequests: { method: string; params: Record<string, unknown> }[] = [];
  const receivedResponses: { id: string; result: unknown }[] = [];

  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve());
    wss.once('error', reject);
  });
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      if (msg.type === 'response') {
        receivedResponses.push({ id: String(msg.id), result: msg.result });
        return;
      }
      const id = String(msg.id);
      const method = String(msg.method);
      const params = (msg.params ?? {}) as Record<string, unknown>;
      receivedRequests.push({ method, params });

      const reply = (result: unknown) => {
        socket.send(
          JSON.stringify({
            jsonrpc: JSONRPC_VERSION,
            factoryApiVersion: LEGACY_FACTORY_API_VERSION,
            factoryProtocolVersion: FACTORY_PROTOCOL_VERSION,
            type: 'response',
            id,
            result,
          }),
        );
      };

      switch (method) {
        case 'daemon.authenticate':
          reply({ userId: 'airgapped-user', orgId: 'airgapped-org' });
          break;
        case 'daemon.check_folder_trust':
          reply({ isTrusted: true, trustRootPath: params.path, promptRequired: false });
          break;
        case 'daemon.initialize_session':
          reply({
            sessionId: 'ses-ws-real',
            settings: {
              modelId: 'claude-sonnet-4-6',
              reasoningEffort: 'high',
              interactionMode: 'auto',
              autonomyLevel: 'high',
            },
            session: { messages: [] },
          });
          // Immediately push a daemon.request_permission over the real WS transport to prove auto-approval!
          socket.send(
            JSON.stringify({
              jsonrpc: JSONRPC_VERSION,
              factoryApiVersion: LEGACY_FACTORY_API_VERSION,
              factoryProtocolVersion: FACTORY_PROTOCOL_VERSION,
              type: 'request',
              id: 'srv-perm-1',
              method: 'daemon.request_permission',
              params: {
                sessionId: 'ses-ws-real',
                toolUses: [],
                options: [
                  { label: 'Proceed once', value: 'proceed_once' },
                  { label: 'Cancel', value: 'cancel' },
                ],
              },
            }),
          );
          break;
        case 'daemon.compact_session':
          reply({ newSessionId: 'ses-ws-handoff', removedCount: 5 });
          break;
        default:
          reply({});
          break;
      }
    });
  });

  writeFileSync(path.join(dataDir, 'setup.json'), JSON.stringify({ onboarded: true, airgapped: true }));
  writeFileSync(path.join(dataDir, 'droid-daemon.json'), JSON.stringify({ pid: process.pid, port, droidPath: '/opt/bin/droid', airgapped: true, authFingerprint: 'airgapped' }), { mode: 0o600 });

  const daemon = new LocalDaemon({
    dataDir,
    home,
    env: () => ({ PATH: '/usr/bin' }),
    resolveDroidPath: () => '/opt/bin/droid',
    isPidAlive: () => true,
    killPid: () => {},
  });
  t.after(() => daemon.disconnect());

  const init = await daemon.initializeSession({
    cwd: repoDir,
    workerSystemPrompt: 'Verify real SDK Zod validation.',
    mcp: { hookUrl: 'http://127.0.0.1:4600', workerHookToken: 'tok-real', workerId: 'w-real' },
    denyTask: true,
  });
  assert.equal(init.sessionId, 'ses-ws-real');

  const handoff = await daemon.compactSession({ sessionId: 'ses-ws-real', mode: 'handoff' });
  assert.equal(handoff.newSessionId, 'ses-ws-handoff');

  // Wait briefly for the async permission response frame to land on the server socket
  for (let i = 0; i < 40 && !receivedResponses.length; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.deepEqual(receivedResponses, [
    {
      id: 'srv-perm-1',
      result: { sessionId: 'ses-ws-real', selectedOption: 'proceed_once' },
    },
  ]);

  const initWire = receivedRequests.find((r) => r.method === 'daemon.initialize_session')?.params;
  assert.ok(initWire);
  assert.equal(initWire.skipPermissionsUnsafe, true);
  assert.equal(initWire.disableInactivityTimeout, true);
  assert.equal(initWire.interactionMode, 'auto');
  assert.equal(initWire.autonomyLevel, 'high');
  const wireMcp = (initWire.mcpServers as Record<string, unknown>[])[0];
  assert.equal('oauth' in wireMcp, false);
});

test('a failed spawn without a PID rejects instead of leaking an unhandled child error', async (t) => {
  const { dataDir, home } = makeTempWorkspace(t);
  const missing = path.join(home, 'missing-droid');
  const daemon = new LocalDaemon({
    dataDir,
    home,
    apiKey: () => 'fk-missing-binary',
    env: () => ({ PATH: '/usr/bin' }),
    resolveDroidPath: () => missing,
    pickPort: async () => 55101,
  });
  await assert.rejects(daemon.ensureStarted(), /Failed to spawn detached droid daemon/);
  assert.equal(existsSync(path.join(dataDir, 'droid-daemon.json')), false);
});

test('handles early child exit, connect deadline cleanup, concurrent ensureStarted deduplication under random delays, and remaining session RPCs', async (t) => {
  const { dataDir, home } = makeTempWorkspace(t);

  // 1. Early child exit fails fast and cleans up droid-daemon.json
  const exitingDaemon = new LocalDaemon({
    dataDir,
    home,
    apiKey: () => 'fk-early-exit',
    env: () => ({ PATH: '/usr/bin' }),
    resolveDroidPath: () => '/opt/bin/droid',
    pickPort: async () => 55101,
    isPidAlive: () => false,
    killPid: () => {},
    spawnDaemon: () => {
      const child = new FakeChild(6001);
      queueMicrotask(() => child.emit('exit', 1, null));
      return child;
    },
    createClient: () => {
      const c = new FakeDaemonClient();
      c.connectFailuresRemaining = 5;
      return c;
    },
  });
  await assert.rejects(() => exitingDaemon.ensureStarted(), /exited early/);
  assert.equal(existsSync(path.join(dataDir, 'droid-daemon.json')), false);

  // 2. Connect timeout kills spawned PID and cleans up state file
  let clock = 1_000;
  const killedOnTimeout: number[] = [];
  const timeoutDaemon = new LocalDaemon({
    dataDir,
    home,
    apiKey: () => 'fk-timeout',
    connectTimeoutMs: 200,
    pollIntervalMs: 50,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    env: () => ({ PATH: '/usr/bin' }),
    resolveDroidPath: () => '/opt/bin/droid',
    pickPort: async () => 55102,
    isPidAlive: () => true,
    killPid: (pid) => killedOnTimeout.push(pid),
    spawnDaemon: () => new FakeChild(6002),
    createClient: () => {
      const c = new FakeDaemonClient();
      c.connectFailuresRemaining = 99;
      return c;
    },
  });
  await assert.rejects(() => timeoutDaemon.ensureStarted(), /Timed out connecting to droid daemon/);
  assert.deepEqual(killedOnTimeout, [6002]);
  assert.equal(existsSync(path.join(dataDir, 'droid-daemon.json')), false);

  // 3. Stress concurrent ensureStarted + RPC calls with random async delays
  for (let trial = 0; trial < 5; trial++) {
    let spawns = 0;
    const client = new FakeDaemonClient();
    const origConnect = client.connect.bind(client);
    client.connect = async (url: string) => {
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 6)));
      return origConnect(url);
    };
    const concurrent = new LocalDaemon({
      dataDir,
      home,
      apiKey: () => `fk-stress-${trial}`,
      env: () => ({ PATH: '/usr/bin' }),
      resolveDroidPath: () => '/opt/bin/droid',
      pickPort: async () => 56000 + trial,
      isPidAlive: () => spawns > 0,
      killPid: () => {},
      spawnDaemon: () => {
        spawns++;
        return new FakeChild(7000 + trial);
      },
      createClient: () => client,
    });
    await Promise.all(Array.from({ length: 8 }, () => concurrent.ensureStarted()));
    assert.equal(spawns, 1);
    assert.equal(concurrent.info()?.pid, 7000 + trial);
    const models = await concurrent.listModels();
    assert.equal(models.models.length, 1);
    await concurrent.interruptSession('ses-1');
    await concurrent.closeSession('ses-1', { preserveEmptyDraft: true });
    assert.deepEqual(client.interruptCalls, [{ sessionId: 'ses-1' }]);
    assert.deepEqual(client.closeCalls, [{ sessionId: 'ses-1', preserveEmptyDraft: true }]);
    concurrent.stop();
    await assert.rejects(() => concurrent.ensureStarted(), /stopped/);
  }
});

test('the detached daemon starts at the filesystem root, not the office process cwd', async (t) => {
  const { dataDir, home } = makeTempWorkspace(t);
  const bin = path.join(home, 'fake-droid');
  // Prints where it was started, then idles like a daemon that never accepts a connection.
  writeFileSync(bin, '#!/bin/sh\npwd -P\nexec sleep 30\n', { mode: 0o755 });
  const daemon = new LocalDaemon({
    dataDir,
    home,
    apiKey: () => 'fk-cwd',
    env: () => ({ PATH: '/usr/bin:/bin' }),
    resolveDroidPath: () => bin,
    pickPort: async () => 55190,
    connectTimeoutMs: 600,
    pollIntervalMs: 50,
    createClient: () => {
      const c = new FakeDaemonClient();
      c.connectFailuresRemaining = 999;
      return c;
    },
  });
  await assert.rejects(() => daemon.ensureStarted(), /Timed out connecting to droid daemon/);
  const log = path.join(dataDir, 'droid-daemon.log');
  const deadline = Date.now() + 5000;
  while (!(existsSync(log) && readFileSync(log, 'utf8').trim()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.equal(readFileSync(log, 'utf8').trim().split('\n')[0], path.parse(os.homedir()).root);
  assert.notEqual(process.cwd(), path.parse(os.homedir()).root);
});
