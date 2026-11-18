import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Orchestrator, type OrchestratorFloor } from '../src/server/orchestrator.js';
import { PtyHost } from '../src/server/ptys.js';
import { Team } from '../src/server/team.js';
import { WorkerManager } from '../src/server/workers.js';
import { ORCHESTRATOR_ID, type OrchestratorBlock } from '../src/shared/mission-control.js';
import { SUBAGENT_DEFAULTS, type WorkerInfo } from '../src/shared/protocol.js';
import { TestDaemon } from './daemon-fixture.js';

type Launch = TestDaemon['launches'][number];

async function until<T>(read: () => T | undefined | false, what: string): Promise<T> {
  const end = Date.now() + 8000;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** An Orchestrator with a controllable daemon and its recorded session operations. */
function rig(t: { after(fn: () => void): void }, dir = mkdtempSync(path.join(tmpdir(), 'orchestrator-')), floors: () => OrchestratorFloor[] = () => [], daemon = new TestDaemon(dir)) {
  let blocked: OrchestratorBlock | undefined;
  const orchestrator = new Orchestrator({
    dataDir: dir,
    agentCmd: '/not-a-real-droid',
    daemon,
    agentArgs: [],
    hook: { url: 'http://127.0.0.1:1', token: '' },
    floors,
    unready: () => blocked,
    changed() {},
    data() {},
    screen() {},
    toast() {},
  });
  t.after(() => {
    orchestrator.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  const launches = () => daemon.launches;
  const launched = async (count: number) => {
    const launch = await until(() => launches()[count - 1], `launch ${count}`);
    await until(() => orchestrator.info?.sessionId === launch.sessionId && orchestrator.info.status !== 'starting', 'session ready');
    return { ...launch, token: launch.options.mcp!.workerHookToken };
  };
  const sent = (launch: Launch) => daemon.messages.filter((message) => message.sessionId === launch.sessionId);
  const typed = (launch: Launch) => sent(launch).map((message) => message.text);
  const started = (launch: Launch, text: string) => daemon.notify(launch.sessionId, { type: 'create_message', message: { id: `user-${typed(launch).length}`, role: 'user', content: text } });
  const completed = (launch: Launch) => daemon.notify(launch.sessionId, { type: 'agent_turn_completed' });
  return {
    dir,
    orchestrator,
    launches,
    launched,
    typed,
    daemon,
    sent,
    started,
    completed,
    block: (why: string | undefined, pane?: OrchestratorBlock['pane']) => {
      blocked = why === undefined ? undefined : { why, ...(pane ? { pane } : {}) };
    },
  };
}

test('starting the daemon-backed Orchestrator retires only its legacy PTY host', { skip: process.platform === 'win32' }, async (t) => {
  const { dir, orchestrator, daemon } = rig(t);
  const legacyDir = path.join(orchestrator.cwd, '.droid-office');
  const floorDir = path.join(dir, 'floor', '.droid-office');
  mkdirSync(floorDir, { recursive: true });
  const legacy = new PtyHost(legacyDir, () => {});
  const floor = new PtyHost(floorDir, () => {});
  t.after(() => floor.stop());
  assert.equal(await legacy.connect(), true);
  let detached = false;
  t.after(async () => {
    if (detached) await new PtyHost(legacyDir, () => {}).stopExisting();
    else legacy.stop();
  });
  assert.equal(await floor.connect(), true);
  const opts = { file: '/bin/cat', args: [], cwd: dir, env: { PATH: '/usr/bin:/bin' }, cols: 80, rows: 24 };
  const oldDroid = legacy.spawn(opts);
  const bossShell = floor.spawn(opts);
  const legacyPid = await until(() => oldDroid.pid || undefined, 'legacy terminal pid');
  const bossPid = await until(() => bossShell.pid || undefined, 'boss shell pid');
  legacy.detach();
  detached = true;

  // Even when the Orchestrator is turned off, it must retire the previous build's host.
  assert.equal(orchestrator.set({ on: false }), undefined);
  await orchestrator.start();
  await until(() => {
    try {
      process.kill(legacyPid, 0);
      return false;
    } catch (err) {
      assert.equal((err as NodeJS.ErrnoException).code, 'ESRCH');
      return true;
    }
  }, 'legacy terminal to stop');
  assert.doesNotThrow(() => process.kill(bossPid, 0));
  assert.equal(floor.hosted, true);
  assert.equal(await new PtyHost(legacyDir, () => {}).stopExisting(), false, 'no host is spawned on a subsequent startup');
  assert.deepEqual(daemon.launches, [], 'the migration does not open a daemon session');
});

test('the Orchestrator starts on its first prompt, takes the next one in the same session, and stops no turn that isn’t running', async (t) => {
  const r = rig(t);
  r.block('Sign in first', 'connections');
  assert.equal(r.orchestrator.prompt('Plan the release'), 'Sign in first');
  assert.equal(r.orchestrator.identity()?.activity, 'Sign in first');
  assert.deepEqual([r.orchestrator.state().blocked, r.orchestrator.state().blockedPane], ['Sign in first', 'connections'], 'it says why, and where to fix it');
  r.block(undefined);
  assert.deepEqual([r.orchestrator.state().blocked, r.orchestrator.state().blockedPane], [undefined, undefined]);
  assert.equal(r.orchestrator.identity()?.activity, 'Ready for its first prompt');
  assert.equal(r.orchestrator.state().agent, undefined);
  assert.equal(r.orchestrator.interrupt(), false, 'no session, so no turn to stop');
  assert.deepEqual(r.launches(), [], 'being asked who it is starts nothing');

  assert.equal(r.orchestrator.prompt('Plan the release'), undefined);
  assert.equal(r.orchestrator.prompt('And list the risks'), undefined, 'a prompt sent before Droid is ready');
  const first = await r.launched(1);
  assert.deepEqual(r.orchestrator.authenticate(ORCHESTRATOR_ID, first.token)?.id, ORCHESTRATOR_ID);
  assert.equal(r.orchestrator.authenticate(ORCHESTRATOR_ID, 'another-worker-token'), undefined);
  await until(() => r.typed(first).length === 2, 'both prompts');
  assert.deepEqual([...r.typed(first)].sort(), ['And list the risks', 'Plan the release']);
  assert.equal(r.launches().length, 1, 'one session, however fast the prompts came');
  assert.equal(r.orchestrator.interrupt(), true, 'a running turn can be interrupted');
  assert.deepEqual(r.daemon.interrupts, [first.sessionId]);
  r.completed(first);
  assert.equal(r.orchestrator.interrupt(), false, 'at rest, so nothing to stop');
});

test('a prompt for an Orchestrator whose session ended carries its conversation on, pictures included', async (t) => {
  const r = rig(t);
  r.orchestrator.prompt('Plan the release');
  const first = await r.launched(1);
  assert.equal(r.orchestrator.workers.halt(ORCHESTRATOR_ID), true);
  // The smallest PNG the office accepts as a picture.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const picture = r.orchestrator.workers.stageImage('mock.png', png);
  assert.ok(picture);
  assert.equal(r.orchestrator.prompt('What is on this mock-up?', [picture]), undefined);
  assert.equal(r.orchestrator.info?.activity, 'What is on this mock-up?', 'its card shows the prompt, not the file list');
  const second = await r.launched(2);
  assert.equal(second.sessionId, first.sessionId);
  const message = await until(() => r.sent(second).at(-1), 'the prompt with its picture');
  assert.equal(message.text, 'What is on this mock-up?');
  assert.equal(message.images?.length, 1);
  assert.deepEqual(message.images, [{ type: 'base64', mediaType: 'image/png', data: png.toString('base64') }]);
});

test('pictures sent alone to an Orchestrator cut off mid-turn reach its session instead of a carry-on note', async (t) => {
  const r = rig(t);
  r.orchestrator.prompt('Plan the release');
  await r.launched(1);
  r.orchestrator.shutdown(true);
  // The office went down mid-turn, and the next one opened without waking it.
  const file = path.join(r.dir, 'orchestrator', '.droid-office', 'workers.json');
  const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
  writeFileSync(file, JSON.stringify(saved.map((s) => ({ ...s, midTurn: true }))));
  const reopened = rig(t, r.dir, undefined, r.daemon);
  const asleep = reopened.orchestrator.workers.asleep;
  reopened.orchestrator.workers.asleep = () => true;
  await reopened.orchestrator.start();
  reopened.orchestrator.workers.asleep = asleep;
  assert.equal(reopened.launches().length, 1);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const picture = reopened.orchestrator.workers.stageImage('mock.png', png);
  assert.ok(picture);
  assert.equal(reopened.orchestrator.prompt('', [picture]), undefined);
  const second = await reopened.launched(2);
  const message = await until(() => reopened.sent(second).at(-1), 'the pictures');
  assert.equal(message.text, '');
  assert.equal(message.images?.length, 1);
});

test('off stops only the Orchestrator’s session; on carries its conversation on, as an office restart does', async (t) => {
  const r = rig(t);
  r.orchestrator.prompt('Plan the release');
  const first = await r.launched(1);
  assert.equal(r.orchestrator.set({ on: false }), undefined);
  assert.equal(r.orchestrator.identity(), undefined, 'it leads nobody while it is off');
  assert.equal(r.orchestrator.authenticate(ORCHESTRATOR_ID, first.token), undefined);
  assert.match(r.orchestrator.prompt('Are you there?') ?? '', /is off/);
  assert.equal(r.orchestrator.tell('Team news'), 'The Orchestrator is off');
  assert.equal(r.orchestrator.state().agent?.worker.sessionId, first.sessionId, 'its conversation is kept');
  assert.deepEqual(JSON.parse(readFileSync(path.join(r.dir, 'orchestrator.json'), 'utf8')), { on: false });
  r.orchestrator.shutdown(true);

  const reopened = rig(t, r.dir, undefined, r.daemon);
  await reopened.orchestrator.start();
  assert.equal(reopened.orchestrator.state().settings.on, false);
  assert.equal(reopened.launches().length, 1, 'an office that opens with it off leaves it asleep');
  assert.equal(reopened.orchestrator.set({ on: true }), undefined);
  const second = await reopened.launched(2);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(reopened.orchestrator.identity()?.id, ORCHESTRATOR_ID);
});

test('a model change updates the Orchestrator’s current daemon session without reopening it', async (t) => {
  const r = rig(t);
  r.orchestrator.prompt('Plan the release');
  const first = await r.launched(1);
  r.started(first, 'Plan the release');
  assert.equal(r.orchestrator.info?.status, 'working');
  assert.equal(r.orchestrator.set({ on: true, model: 'claude-haiku-5-5', effort: 'low' }), undefined);
  assert.equal(r.orchestrator.workers.running(ORCHESTRATOR_ID), true);
  await until(() => r.orchestrator.info?.activeModel === 'claude-haiku-5-5', 'model settings to apply');
  assert.deepEqual(r.daemon.settingsChanges, [{ sessionId: first.sessionId, modelId: 'claude-haiku-5-5', reasoningEffort: 'low' }]);
  assert.equal(r.launches().length, 1, 'the session stays open');
  assert.deepEqual([r.orchestrator.info?.model, r.orchestrator.info?.effort], ['claude-haiku-5-5', 'low']);
  assert.deepEqual(JSON.parse(readFileSync(path.join(r.dir, 'orchestrator.json'), 'utf8')), { on: true, model: 'claude-haiku-5-5', effort: 'low' });
});

test('a halted session resumes the same conversation with its chosen model', async (t) => {
  const r = rig(t);
  r.orchestrator.prompt('Plan the release');
  const first = await r.launched(1);
  r.started(first, 'Plan the release');
  assert.equal(r.orchestrator.workers.halt(ORCHESTRATOR_ID), true);
  assert.equal(r.orchestrator.set({ on: true, model: 'claude-haiku-5-5' }), undefined);
  assert.equal(r.orchestrator.prompt('Carry on'), undefined);
  const second = await r.launched(2);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(r.orchestrator.info?.model, 'claude-haiku-5-5');
  assert.equal(await until(() => r.typed(second).at(-1), 'the prompt that woke it'), 'Carry on');
  r.started(second, 'Carry on');
  r.completed(second);
  const rested = await until(() => r.orchestrator.info?.status !== 'working' && r.orchestrator.info?.status, 'its turn to end');
  assert.equal(rested, 'done', 'it rests on the model it already started on');
  assert.equal(r.orchestrator.authenticate(ORCHESTRATOR_ID, second.token)?.id, ORCHESTRATOR_ID, 'the same session is still its own');
  assert.equal(r.launches().length, 2);
});

test('a new conversation ends the Orchestrator’s session, and a prompt sent straight after starts a fresh one', async (t) => {
  const r = rig(t);
  r.orchestrator.prompt('Plan the release');
  const first = await r.launched(1);
  r.orchestrator.reset();
  assert.equal(r.orchestrator.state().agent, undefined);
  assert.equal(r.orchestrator.authenticate(ORCHESTRATOR_ID, first.token), undefined, 'the old session’s token is dead');
  assert.equal(r.orchestrator.identity()?.id, ORCHESTRATOR_ID, 'it is still who its team reports to');
  assert.equal(r.orchestrator.tell('Team news'), 'The Orchestrator has no session running');
  assert.equal(r.orchestrator.prompt('Start over'), undefined);
  const second = await r.launched(2);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.notEqual(second.token, first.token);
  assert.equal(r.orchestrator.info?.sessionId, second.sessionId);
});

test('reset during initialization closes the abandoned session without sending its buffered prompt', async (t) => {
  const r = rig(t);
  const init = Promise.withResolvers<void>();
  r.daemon.beforeInitialize = () => init.promise;
  r.orchestrator.prompt('Abandon this');
  const first = await until(() => r.launches()[0], 'first initialization');
  r.orchestrator.reset();
  r.daemon.beforeInitialize = undefined;
  r.orchestrator.prompt('Start again');
  const second = await r.launched(2);
  init.resolve();
  await until(() => r.daemon.closed.includes(first.sessionId), 'abandoned session closed');
  assert.notEqual(second.sessionId, first.sessionId);
  assert.deepEqual(r.typed(first), []);
  assert.deepEqual(r.typed(second), ['Start again']);
  assert.equal(r.orchestrator.info?.sessionId, second.sessionId);
});

test('a prompt carries the owner’s floor once: on the first prompt, and again only when the floor changes', async (t) => {
  const r = rig(t);
  const alpha = { name: 'droid-office', dir: '/Users/nik/repos/droid-office' };
  const beta = { name: 'website', dir: '/Users/nik/repos/website' };
  const hintFor = (f: { name: string; dir: string }) => `\n\nDroid Office notice: The owner sent this from the ${f.name} floor (${f.dir}).`;

  r.block('Sign in first');
  assert.equal(r.orchestrator.prompt('Get all open PRs merged', [], false, alpha), 'Sign in first');
  r.block(undefined);
  assert.equal(r.orchestrator.prompt('Get all open PRs merged', [], false, alpha), undefined, 'a prompt that was refused did not use up the hint');
  const first = await r.launched(1);
  const message = await until(() => r.typed(first)[0], 'the first prompt');
  assert.equal(message, `Get all open PRs merged${hintFor(alpha)}`, 'the owner’s words, then the floor and its checkout');
  assert.equal(r.orchestrator.info?.prompt, 'Get all open PRs merged', 'its card shows what the owner typed');
  assert.equal(message.includes('<'), false, 'no tag for Droid to escape');
  r.started(first, message);
  assert.equal(r.orchestrator.info?.activity, 'Get all open PRs merged', 'a hook carrying the floor line does not put it on the card');
  assert.deepEqual([r.orchestrator.info?.task?.name, r.orchestrator.info?.task?.summary], ['Get all open PRs', 'Get all open PRs merged'], 'nor does it end up in its task label');
  r.completed(first);

  const next = async (text: string, floor?: { name: string; dir: string }) => {
    const count = r.typed(first).length;
    assert.equal(r.orchestrator.prompt(text, [], false, floor), undefined);
    const sent = await until(() => r.typed(first).length > count && r.typed(first)[count], text);
    r.started(first, sent);
    r.completed(first);
    return sent;
  };
  assert.equal(await next('And the issues', alpha), 'And the issues', 'the same floor again adds nothing');
  assert.equal(await next('Now the other repo', beta), `Now the other repo${hintFor(beta)}`, 'a different floor is named once');
  assert.equal(await next('Check its CI', beta), 'Check its CI');
  assert.equal(await next('From Mission Control'), 'From Mission Control', 'no floor, no hint');
  assert.equal(await next('Back on the same floor', beta), 'Back on the same floor', 'Mission Control did not change the last floor named');
  assert.equal(await next('Back to the first', alpha), `Back to the first${hintFor(alpha)}`);
  assert.equal(r.launches().length, 1);

  // A session that ended resumes the same conversation, which already knows the floor.
  r.orchestrator.workers.halt(ORCHESTRATOR_ID);
  assert.equal(r.orchestrator.prompt('Carry on', [], false, alpha), undefined);
  const second = await r.launched(2);
  assert.equal(await until(() => r.typed(second).at(-1), 'the resumed prompt'), 'Carry on');

  // A new conversation starts the naming over.
  r.orchestrator.reset();
  assert.equal(r.orchestrator.prompt('Start over', [], false, alpha), undefined);
  const third = await r.launched(3);
  assert.equal(await until(() => r.typed(third)[0], 'the new conversation’s prompt'), `Start over${hintFor(alpha)}`);
});

test('a prompt from Mission Control, with no floor, starts the Orchestrator with no hint', async (t) => {
  const r = rig(t);
  assert.equal(r.orchestrator.prompt('What is everyone doing?'), undefined);
  const first = await r.launched(1);
  assert.equal(await until(() => r.typed(first)[0], 'the prompt'), 'What is everyone doing?');
});

test('its team’s news is typed into an Orchestrator at rest, and handed over at the end of a turn in progress', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orchestrator-'));
  const floors: OrchestratorFloor[] = [];
  let floor: WorkerManager | undefined;
  let team: Team | undefined;
  // Before the rig's own cleanup, which removes the folder they save to.
  t.after(() => {
    team?.stop();
    floor?.shutdown();
  });
  const r = rig(t, dir, () => floors);
  const sub: WorkerInfo = { id: 'sub', name: 'Byte', kind: 'agent', deskId: 'desk-1', color: '#4f9dde', status: 'working', acked: true, createdBy: 'owner', createdAt: 1, cols: 100, rows: 30, open: false, lead: ORCHESTRATOR_ID };
  mkdirSync(path.join(dir, 'floor'));
  const building = {
    agents: {
      identity: (id: string) => (id === ORCHESTRATOR_ID ? r.orchestrator.identity() : undefined),
      known: (id: string) => id === ORCHESTRATOR_ID,
      tell: (_id: string, text: string) => r.orchestrator.tell(text),
    },
    floor: 'alpha',
  };
  floor = new WorkerManager(dir, path.join(dir, 'floor'), '/not-a-droid', [], { url: 'http://127.0.0.1:1', token: '' }, { update() {}, remove() {}, data() {}, screen() {}, toast() {} }, undefined, undefined, undefined, true, building);
  const workers = floor;
  team = new Team(
    {
      list: () => [sub],
      get: (id) => (id === sub.id ? sub : workers.buildingIdentity(id)),
      officeDefault: undefined,
      deskOccupied: () => false,
      hire: () => 'Not used',
      prompt: (id, text) => workers.tell(id, text),
      resume: () => undefined,
      kill: async () => ({}),
      tail: () => '',
      setTask() {},
    },
    // A clock a minute ahead: the prompt just typed for the owner no longer holds a wake note back.
    { dataDir: path.join(dir, 'team'), dir, git: false, settings: () => ({ ...SUBAGENT_DEFAULTS, wakeLead: true }), toast() {}, nudgeDelayMs: 1, now: () => Date.now() + 60_000 },
  );
  floors.push({ id: 'alpha', def: { name: 'alpha' }, workers: { list: () => [sub] }, team });

  assert.equal(r.orchestrator.prompt('Plan the release'), undefined);
  const session = await r.launched(1);
  await until(() => r.typed(session).length === 1, 'the prompt its session started for');
  r.completed(session);
  assert.equal((await team.handle(sub, { action: 'report', text: 'Tests passed' })).status, 200);
  assert.match(await until(() => r.typed(session)[1], 'the wake note typed in at rest'), /Byte reported back/);

  r.started(session, 'Read the report');
  assert.equal((await team.handle(sub, { action: 'report', text: 'Which branch?', question: true })).status, 200);
  assert.equal(r.typed(session).length, 2, 'the mid-turn report waits');
  r.completed(session);
  assert.match(await until(() => r.typed(session)[2], 'notice at turn end'), /Byte asked you a question/);

  // Its subagent finishes a turn without a word while the Orchestrator's own turn goes on.
  for (const status of ['idle', 'working', 'done'] as const) {
    sub.status = status;
    team.onWorker({ ...sub });
  }
  r.completed(session);
  assert.match(await until(() => r.typed(session)[3], 'the wake note once its turn ended'), /Byte finished its turn without reporting/);
  assert.equal(r.typed(session).length, 4, 'nothing was typed into the turn in progress');
});
