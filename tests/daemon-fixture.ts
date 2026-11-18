import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  LocalDaemon,
  type LocalAddUserMessageParams,
  type LocalAskUserEvent,
  type LocalForkSessionParams,
  type LocalInitializeSessionOptions,
  type LocalLoadSessionOptions,
  type LocalSessionNotificationEvent,
  type LocalUpdateSettingsParams,
} from '../src/server/local-daemon.js';

/** In-process daemon boundary for office integration tests. The SDK transport is tested separately. */
export class TestDaemon extends LocalDaemon {
  readonly launches: { sessionId: string; options: LocalInitializeSessionOptions | LocalLoadSessionOptions }[] = [];
  readonly messages: LocalAddUserMessageParams[] = [];
  readonly answers: Parameters<LocalDaemon['sendAskUserResponse']>[1][] = [];
  readonly settingsChanges: LocalUpdateSettingsParams[] = [];
  readonly closed: string[] = [];
  readonly interrupts: string[] = [];
  readonly forks: LocalForkSessionParams[] = [];
  readonly queueChanges: Parameters<LocalDaemon['resolveQueuedUserMessage']>[0][] = [];
  nextSessionId?: string;
  beforeFork?: (params: LocalForkSessionParams) => Promise<void>;
  beforeInitialize?: (options: LocalInitializeSessionOptions) => Promise<void>;
  private readonly events = new EventEmitter();
  private readonly asks = new Map<string, NonNullable<LocalAskUserEvent['ask']>>();
  private readonly open = new Set<string>();
  private readonly settings = new Map<string, Record<string, unknown>>();
  private readonly working = new Map<string, string>();

  constructor(dataDir: string) {
    super({
      dataDir,
      agentCmd: '/not-a-real-droid',
      createClient: () => {
        throw new Error('Unexpected daemon transport access in an office test');
      },
    });
  }

  override async initializeSession(options: LocalInitializeSessionOptions) {
    const sessionId = options.sessionId ?? this.nextSessionId ?? randomUUID();
    this.nextSessionId = undefined;
    this.launches.push({ sessionId, options });
    await this.beforeInitialize?.(options);
    this.open.add(sessionId);
    const settings = { modelId: options.modelId ?? 'claude-sonnet-4-6', reasoningEffort: options.reasoningEffort ?? 'high' };
    this.settings.set(sessionId, settings);
    return { sessionId, settings, session: { messages: [] } };
  }

  override async loadSession(options: LocalLoadSessionOptions) {
    this.launches.push({ sessionId: options.sessionId, options });
    this.open.add(options.sessionId);
    return this.snapshot(options.sessionId);
  }

  override async adoptSessions(sessions: readonly (string | LocalLoadSessionOptions)[]) {
    const openedSessionIds = [...this.open];
    const adopted = new Map<string, Record<string, unknown>>();
    for (const session of sessions) {
      const options = typeof session === 'string' ? { sessionId: session } : session;
      adopted.set(options.sessionId, this.open.has(options.sessionId) ? this.snapshot(options.sessionId) : await this.loadSession(options));
    }
    return { openedSessionIds, adopted, failed: new Map<string, Error>() };
  }

  private snapshot(sessionId: string) {
    return { settings: this.settings.get(sessionId), session: { messages: [] }, workingState: this.working.get(sessionId) ?? 'idle' };
  }

  override async addUserMessage(params: LocalAddUserMessageParams) {
    this.messages.push(params);
    return { requestId: params.requestId ?? randomUUID() };
  }

  override async closeSession(sessionId: string) {
    this.closed.push(sessionId);
    this.open.delete(sessionId);
    this.working.delete(sessionId);
    this.asks.delete(sessionId);
  }

  override stop() {
    for (const sessionId of this.open) void this.closeSession(sessionId);
    super.stop();
  }

  override async interruptSession(sessionId: string) {
    this.interrupts.push(sessionId);
  }

  override async updateSessionSettings(params: LocalUpdateSettingsParams) {
    this.settingsChanges.push(params);
    const { sessionId, ...settings } = params;
    this.settings.set(sessionId, { ...this.settings.get(sessionId), ...settings });
  }

  override async forkSession(params: LocalForkSessionParams) {
    this.forks.push(params);
    await this.beforeFork?.(params);
    const newSessionId = randomUUID();
    this.open.add(newSessionId);
    return { newSessionId, resolvedCwd: params.cwd, snapshot: this.snapshot(params.sessionId) };
  }

  override async listSlashCommands() {
    return [];
  }

  override async resolveQueuedUserMessage(params: Parameters<LocalDaemon['resolveQueuedUserMessage']>[0]) {
    this.queueChanges.push(params);
  }

  override onSessionNotification(handler: (event: LocalSessionNotificationEvent) => void): () => void;
  override onSessionNotification(sessionId: string, handler: (notification: LocalSessionNotificationEvent['notification']) => void): () => void;
  override onSessionNotification(first: string | ((event: LocalSessionNotificationEvent) => void), second?: (notification: LocalSessionNotificationEvent['notification']) => void) {
    const handler =
      typeof first === 'function'
        ? first
        : (event: LocalSessionNotificationEvent) => {
            if (event.sessionId === first) second?.(event.notification);
          };
    this.events.on('notification', handler);
    return () => {
      this.events.off('notification', handler);
    };
  }

  notify(sessionId: string, notification: Record<string, unknown>) {
    if (notification.type === 'agent_turn_completed') this.working.delete(sessionId);
    if (notification.type === 'droid_working_state_changed' && typeof notification.newState === 'string') this.working.set(sessionId, notification.newState);
    this.events.emit('notification', { sessionId, notification });
  }

  override onAskUser(handler: (event: LocalAskUserEvent) => void) {
    this.events.on('ask', handler);
    return () => {
      this.events.off('ask', handler);
    };
  }

  ask(sessionId: string, ask: LocalAskUserEvent['ask']) {
    if (ask) this.asks.set(sessionId, ask);
    else this.asks.delete(sessionId);
    this.events.emit('ask', { sessionId, ask });
  }

  override pendingAsk(sessionId: string) {
    return this.asks.get(sessionId);
  }

  override sendAskUserResponse(_requestId: string, result: Parameters<LocalDaemon['sendAskUserResponse']>[1]) {
    this.answers.push(result);
    this.ask(result.sessionId, undefined);
    return true;
  }
}
