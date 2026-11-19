import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CARRY_ON_PROMPT, NAMES, WorkerManager, type WorkerEvents } from '../src/server/workers.js';
import type { ToolRefresh } from '../src/server/hook-refresh.js';
import { Worktrees } from '../src/server/worktrees.js';
import type { PromptSource } from '../src/server/prompts.js';
import { PROMPTS, WORKER_TEAM_LEAD, WORKER_VISITS } from '../src/shared/prompts.js';
import type { AgentChoice, AgentEffort, GhPull, WorkerInfo } from '../src/shared/protocol.js';
import { nextFreeSeat } from '../src/shared/layout.js';
import { TestDaemon } from './daemon-fixture.js';
import type { LocalInitializeSessionOptions } from '../src/server/local-daemon.js';
import { airgappedModelError } from '../src/server/droid-models.js';

test('retry after a daemon start timeout sends the hire prompt and buffered follow-up exactly once', async (t) => {
  const f = fixture();
  isolateAgentEnvironment(f, t);
  t.after(() => f.close());
  const workers = manager(f, []);
  const timeout = Promise.withResolvers<void>();
  f.daemon.beforeInitialize = () => timeout.promise;
  const prompt = 'Reply with exactly the retained hire prompt.';
  const worker = workers.spawn('desk-2', 'owner', prompt);
  assert.ok(typeof worker === 'object');
  assert.equal(workers.prompt(worker.id, 'And check the notes.'), undefined);
  timeout.reject(new Error('Timed out connecting to droid daemon on 127.0.0.1:49152'));
  await waitFor(
    () => worker.status,
    (state) => state === 'exited',
  );
  assert.match(worker.activity ?? '', /^Failed to start: Timed out connecting/);
  assert.equal(worker.prompt, prompt);
  assert.deepEqual(f.daemon.messages, []);
  workers.wakeAll();
  assert.equal(worker.status, 'exited', 'reopening the floor leaves Retry available');

  f.daemon.beforeInitialize = undefined;
  assert.equal(workers.resume(worker.id), undefined);
  await waitFor(
    () => f.daemon.messages.length,
    (count) => count === 2,
  );
  assert.deepEqual(
    f.daemon.messages.map((m) => m.text),
    [prompt, 'And check the notes.'],
  );
  assert.equal(worker.activity, undefined);
  assert.equal(worker.exitCode, undefined);
  assert.equal(worker.status, 'working');
});

type Invocation = {
  pid: number;
  kind: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env: {
    workerId?: string;
    hookToken?: string;
    hookUrl?: string;
    path?: string;
    ceiling?: string;
  };
};

type Fixture = {
  root: string;
  data: string;
  log: string;
  droid: string;
  managers: WorkerManager[];
  daemon: TestDaemon;
  read(): Invocation[];
  close(): void;
};

/** Keep the Droid CLI in this test fixture from seeing a user's config or credentials. */
function isolateAgentEnvironment(f: Fixture, t: { after(fn: () => void): void }) {
  const previous: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  };
  const home = path.join(f.root, 'home');
  const config = path.join(f.root, 'config');
  process.env.PATH = `${path.dirname(f.droid)}${path.delimiter}${previous.PATH ?? ''}`;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = config;
  process.env.XDG_DATA_HOME = path.join(f.root, 'xdg-data');
  process.env.XDG_STATE_HOME = path.join(f.root, 'xdg-state');
  process.env.XDG_CACHE_HOME = path.join(f.root, 'xdg-cache');
  // Keep credential values only in memory to restore the parent environment; never log them.
  for (const key of Object.keys(process.env)) {
    // These are the office hook variables used by the in-process tests;
    // they are synthetic protocol values, not credentials.
    if (key.startsWith('DROID_OFFICE_')) continue;
    if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|CREDENTIAL|TOKEN)/i.test(key)) {
      previous[key] = process.env[key];
      delete process.env[key];
    }
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const fakeAgent = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const log = process.env.FAKE_AGENT_LOG;
const kind = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const record = (extra = {}) => fs.appendFileSync(log, JSON.stringify({
  kind,
  args,
  pid: process.pid,
  cwd: process.cwd(),
  ...extra,
  env: {
    workerId: process.env.DROID_OFFICE_WORKER_ID,
    hookToken: process.env.DROID_OFFICE_HOOK_TOKEN,
    hookUrl: process.env.DROID_OFFICE_HOOK_URL,
    path: process.env.PATH,
    ceiling: process.env.GIT_CEILING_DIRECTORIES,
  },
}) + '\\n');
record();

process.stdout.write('fake-agent-ready\\r\\n');
// FAKE_AGENT_SCREENS: screens to draw in turn, the first at once and the next on each key.
const screens = JSON.parse(process.env.FAKE_AGENT_SCREENS || '[]');
const draw = () => screens.length && process.stdout.write('\\x1b[2J\\x1b[H' + screens.shift().join('\\r\\n'));
draw();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  record({ stdin: chunk });
  draw();
});
process.stdin.resume();
const delay = Number(process.env.FAKE_AGENT_EXIT_MS || 0);
if (delay > 0) setTimeout(() => process.exit(0), delay).unref();
`;

function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'droid-office-workers-'));
  const data = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'invocations.jsonl');
  const droid = path.join(bin, 'droid');
  mkdirSync(data, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(droid, fakeAgent, { mode: 0o700 });
  writeFileSync(log, '');
  const managers: WorkerManager[] = [];
  return {
    root,
    data,
    log,
    droid,
    managers,
    daemon: new TestDaemon(data),
    read() {
      if (!existsSync(log)) return [];
      // A poll can land mid-append. A finished record always ends with a newline, so a trailing segment without one is not a record yet.
      const text = readFileSync(log, 'utf8');
      const lines = text.split('\n');
      if (text.length > 0 && !text.endsWith('\n')) lines.pop();
      return lines.filter(Boolean).map((line) => JSON.parse(line) as Invocation);
    },
    close() {
      // node:test runs after hooks in registration order, before later shutdown hooks.
      // Stop writers and timers before removing the state they own.
      for (const workers of managers) workers.shutdown();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function events(updates: WorkerInfo[]): WorkerEvents {
  return {
    update: (info) => updates.push(info),
    remove() {},
    data() {},
    screen() {},
    toast() {},
  };
}

function managed(f: Fixture, ...args: ConstructorParameters<typeof WorkerManager>) {
  args[12] ??= f.daemon;
  const workers = new WorkerManager(...args);
  f.managers.push(workers);
  return workers;
}

function manager(f: Fixture, updates: WorkerInfo[], args = ['--from-test']) {
  return managed(f, f.root, f.data, f.droid, args, { url: 'http://127.0.0.1:1', token: '' }, events(updates));
}

test('airgapped worker launches pin a configured custom model and reject hosted defaults before taking a seat', async (t) => {
  const f = fixture();
  isolateAgentEnvironment(f, t);
  const previous = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    f.close();
    if (previous === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = previous;
  });
  const id = 'custom:droidproxy:gpt-6-sol';
  const workers = manager(f, []);
  workers.modelGate = (model) => airgappedModelError(true, model, { models: [{ id, displayName: id, custom: true }], defaultModel: 'auto' });
  assert.match(workers.spawn('desk-1', 'owner') as string, /configured custom model/);
  assert.match(workers.spawn('desk-1', 'owner', undefined, false, 'agent', 'auto') as string, /configured custom model/);
  assert.equal(workers.list().length, 0);
  const result = workers.spawn('desk-1', 'owner', undefined, false, 'agent', id);
  assert.notEqual(typeof result, 'string');
  const [launch] = f.daemon.launches;
  assert.ok('cwd' in launch.options);
  assert.equal(launch.options.modelId, id);
  if (typeof result === 'string') return;
  // A worker created before the switch must not restart or fork on a now-ineligible model.
  workers.halt(result.id);
  result.model = 'auto';
  assert.match(workers.resume(result.id)!, /configured custom model/);
  assert.match((await workers.fork(result.id, 'owner')) as string, /configured custom model/);
});

test('a plain shell gets its hook identity for worktree setup reporting; Office MCP refuses non-agents itself', async (t) => {
  const f = fixture();
  isolateAgentEnvironment(f, t);
  const previous = { SHELL: process.env.SHELL, FAKE_AGENT_LOG: process.env.FAKE_AGENT_LOG };
  process.env.SHELL = f.droid;
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    f.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const workers = manager(f, []);
  const shell = workers.spawn('desk-1', 'test', undefined, false, 'shell');
  assert.notEqual(typeof shell, 'string');
  const launch = (await waitFor(f.read, (records) => records.length > 0))[0];
  assert.deepEqual(launch.args, ['-l']);
  assert.equal(launch.env.workerId, (shell as WorkerInfo).id);
  assert.match(launch.env.hookToken ?? '', /^[0-9a-f]{32}$/);
  assert.equal(launch.env.hookUrl, 'http://127.0.0.1:1');
});

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeout = 4000): Promise<T> {
  const end = Date.now() + timeout;
  let value = read();
  while (!predicate(value) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = read();
  }
  assert.ok(predicate(value), 'timed out waiting for fake agent state');
  return value;
}

/** The messages the office pasted into one launch's terminal, oldest first. */
async function initializedWorker(f: Fixture, id: string) {
  const launch = await waitFor(() => f.daemon.launches.find((entry) => entry.options.mcp?.workerId === id && 'cwd' in entry.options), Boolean);
  if (!launch || !('cwd' in launch.options)) throw new Error(`No initialization for worker ${id}`);
  return { ...launch, options: launch.options as LocalInitializeSessionOptions };
}

test('the initial prompt waits for daemon initialization and a resume uses the same conversation', async (t) => {
  const f = carryOnFixture(t);
  const updates: WorkerInfo[] = [];
  const workers = manager(f, updates);
  const init = Promise.withResolvers<void>();
  t.after(() => init.resolve());
  f.daemon.beforeInitialize = () => init.promise;
  const worker = workers.spawn('desk-2', 'test', '- inspect this code');
  if (typeof worker === 'string') return assert.fail(worker);
  assert.equal(worker.task?.summary, '- inspect this code');
  assert.equal(worker.task?.generated, undefined);
  const first = await initializedWorker(f, worker.id);
  assert.equal(first.options.mcp?.workerId, worker.id);
  assert.ok(first.options.mcp?.workerHookToken);
  assert.equal(workers.authenticate(worker.id, 'wrong-token'), undefined);
  assert.equal(workers.authenticate(worker.id, first.options.mcp!.workerHookToken)?.id, worker.id);
  assert.match(first.options.workerSystemPrompt ?? '', new RegExp(`^You're ${worker.name}, a worker in Droid Office`));
  assert.match(first.options.workerSystemPrompt ?? '', /team_hire/);
  assert.match(first.options.workerSystemPrompt ?? '', /whiteboard_card/);
  assert.doesNotMatch(first.options.workerSystemPrompt ?? '', /\{\{/);
  assert.deepEqual(f.daemon.messages, []);
  init.resolve();
  await waitFor(
    () => f.daemon.messages.length,
    (n) => n === 1,
  );
  assert.deepEqual(
    f.daemon.messages.map((m) => [m.sessionId, m.text]),
    [[first.sessionId, '- inspect this code']],
  );
  f.daemon.notify(first.sessionId, { type: 'agent_turn_completed' });
  assert.equal(worker.status, 'done');
  assert.equal(workers.halt(worker.id), true);
  f.daemon.notify(first.sessionId, { type: 'droid_working_state_changed', newState: 'thinking' });
  assert.equal(worker.status, 'exited', 'late events do not wake a closed worker');
  assert.equal(workers.resume(worker.id), undefined);
  await waitFor(
    () => f.daemon.launches.length,
    (n) => n === 2,
  );
  assert.equal(f.daemon.launches[1].sessionId, first.sessionId);
  assert.equal(worker.task?.summary, '- inspect this code', 'resuming does not replace the initial preview');
  workers.setTask(worker.id, { name: 'Worker sessions', summary: 'Verified resume handling', generated: true, textHash: 'a'.repeat(64) });
  f.daemon.notify(first.sessionId, { type: 'create_message', message: { id: 'u', role: 'user', content: 'continue with another check' } });
  assert.equal(worker.task?.summary, 'Verified resume handling');
  const pull = { number: 42, url: 'https://github.com/example/project/pull/42' };
  workers.recordPull(worker.id, pull);
  assert.deepEqual(updates.at(-1)?.pr, pull);
  workers.shutdown();
  const restored = manager(f, []);
  await restored.start();
  assert.equal(restored.get(worker.id)?.sessionId, first.sessionId);
  assert.equal(restored.get(worker.id)?.task?.textHash, 'a'.repeat(64));
  assert.deepEqual(restored.get(worker.id)?.pr, pull);
});
test('the office’s hires treat a desk and name held as taken', (t) => {
  const f = fixture();
  isolateAgentEnvironment(f, t);
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  assert.equal(workers.deskOccupied('desk-2'), false);
  const heldName = NAMES[0];
  workers.holds = { desk: (id) => id === 'desk-2', names: () => [heldName] };
  assert.equal(workers.deskOccupied('desk-2'), true);
  assert.equal(workers.ownDesk('desk-2'), false);
  assert.match(String(workers.spawn('desk-2', 'test')), /taken/);
  const spawned = workers.spawn('desk-1', 'test');
  assert.equal(typeof spawned, 'object');
  if (typeof spawned === 'object') {
    assert.notEqual(spawned.name, heldName);
    assert.equal(spawned.name, NAMES[1]);
  }
});

test('a named desk ignores other floors while automatic seats avoid them', (t) => {
  const f = fixture();
  isolateAgentEnvironment(f, t);
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  const elsewhere = { worker: { name: 'Pixel' } as WorkerInfo, floorName: 'sabre' };
  workers.holds = { desk: () => false, names: () => [], liveDeskElsewhere: (id) => (id === 'desk-1' ? elsewhere : undefined), liveNamesElsewhere: () => ['Pixel'] };
  assert.equal(workers.deskOccupied('desk-1'), true, 'automatic picks treat it as taken');
  assert.equal(workers.pickSeat(nextFreeSeat)?.id, 'desk-2');
  const picked = workers.spawn('desk-1', 'owner');
  assert.equal(typeof picked, 'object', String(picked));
  if (typeof picked === 'object') {
    assert.equal(picked.deskId, 'desk-1');
    assert.notEqual(picked.name, 'Pixel');
  }
  assert.equal(workers.spawn('desk-1', 'owner'), 'That desk is taken');
});

test('daemon workers pin their model and effort and keep the choice across restart', async (t) => {
  const f = carryOnFixture(t);
  const workers = manager(f, []);
  const model = 'custom:droidproxy:gpt-6-sol';
  const worker = workers.spawn('desk-3', 'test', 'do the thing', false, 'agent', model, 'high');
  if (typeof worker === 'string') return assert.fail(worker);
  assert.deepEqual([worker.model, worker.effort], [model, 'high']);
  const launch = await initializedWorker(f, worker.id);
  assert.deepEqual([launch.options.modelId, launch.options.reasoningEffort], [model, 'high']);
  assert.equal(existsSync(path.join(f.data, `droid-${worker.id}.json`)), false, 'no per-worker PTY overlay is written');
  await waitFor(() => worker.sessionId, Boolean);
  workers.shutdown();
  const restored = manager(f, []);
  await restored.start();
  assert.deepEqual([restored.get(worker.id)?.model, restored.get(worker.id)?.effort], [model, 'high']);
  assert.equal(restored.get(worker.id)?.sessionId, launch.sessionId);
});
test('opening a git floor creates the branch setting in its checkout before any workers launch', (t) => {
  const f = fixture();
  t.after(() => f.close());
  execFileSync('git', ['init', '-q', '-b', 'main', f.root]);
  const file = path.join(f.root, '.droid-office', 'floor-branch.json');
  assert.equal(existsSync(file), false);
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { branch: null });
  assert.equal(existsSync(path.join(f.data, 'floor-branch.json')), false, 'use the project checkout, not a separate worker data directory');
  assert.deepEqual(f.read(), [], 'no agent has launched');
});

test('the worker system prompt is the office’s as rewritten, filled in for each worker, and none when it is empty', async (t) => {
  const f = fixture();
  isolateAgentEnvironment(f, t);
  const previousLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (previousLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = previousLog;
    f.close();
  });
  let system = 'You are {{name}}, at a desk.';
  const prompts: PromptSource = { text: (id) => (id === 'worker.system' ? system : PROMPTS[id].text), agent: () => undefined };
  const workers = managed(f, f.root, f.data, f.droid, [], { url: 'http://127.0.0.1:1', token: '' }, events([]), undefined, undefined, prompts);
  t.after(() => workers.shutdown());
  const a = workers.spawn('desk-2', 'test', 'look around');
  if (typeof a === 'string') return assert.fail(a);
  assert.equal((await initializedWorker(f, a.id)).options.workerSystemPrompt, `You are ${a.name}, at a desk.`);
  await workers.kill(a.id);

  new Worktrees(f.root).saveBranch('release/next');
  const overridden = workers.spawn('desk-2', 'test', 'work on the floor branch', true);
  // This fixture isn't a repository; the worktree request must not silently start elsewhere.
  assert.equal(typeof overridden, 'string');
  const custom = workers.spawn('desk-2', 'test', 'read only');
  if (typeof custom === 'string') return assert.fail(custom);
  const customSystem = (await initializedWorker(f, custom.id)).options.workerSystemPrompt!;
  assert.match(customSystem, new RegExp(`^You are ${custom.name}, at a desk\\.`));
  assert.match(customSystem, /floor branch is currently `release\/next`/);
  assert.match(customSystem, /floor-branch\.json/);
  await workers.kill(custom.id);

  system = '';
  const b = workers.spawn('desk-3', 'test', 'look around');
  if (typeof b === 'string') return assert.fail(b);
  assert.equal((await initializedWorker(f, b.id)).options.workerSystemPrompt, undefined, 'an empty prompt adds nothing');
  assert.equal(existsSync(path.join(f.data, `system-${b.id}.md`)), false);
});

test('only a worker with no lead is told about the visit tools, and only while visits are on', async (t) => {
  const f = fixture();
  isolateAgentEnvironment(f, t);
  const previousLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (previousLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = previousLog;
    f.close();
  });
  let on = true;
  let system = PROMPTS['worker.system'].text;
  const prompts: PromptSource = { text: (id) => (id === 'worker.system' ? system : PROMPTS[id].text), agent: () => undefined };
  const workers = managed(f, f.root, f.data, f.droid, [], { url: 'http://127.0.0.1:1', token: '' }, events([]), undefined, undefined, prompts);
  workers.visitsOn = () => on;
  t.after(() => workers.shutdown());
  const systemOf = async (id: string) => (await initializedWorker(f, id)).options.workerSystemPrompt ?? '';

  const lead = workers.spawn('desk-2', 'test', 'look around');
  if (typeof lead === 'string') return assert.fail(lead);
  assert.match(await systemOf(lead.id), /`visit_roster`, `visit_look` and `visit_message`/);
  assert.match(await systemOf(lead.id), /when your task needs something from an independent worker/);
  assert.match(await systemOf(lead.id), /Use the Droid Office MCP tools/);
  assert.match(await systemOf(lead.id), /`team_hire`/);
  assert.match(await systemOf(lead.id), /`team_models`/);
  assert.match(await systemOf(lead.id), /`worker_model`/);

  const sub = workers.spawn('desk-3', 'test', 'help out', false, 'agent', undefined, undefined, [], lead.id);
  if (typeof sub === 'string') return assert.fail(sub);
  for (const allowed of [/`team_board`/, /`team_note`/, /`team_report`/, /`lead_notify`/, /`whiteboard_card`/]) {
    assert.match(await systemOf(sub.id), allowed);
  }
  for (const omitted of [/visit_roster/, /team_hire/, /team_models/, /worker_model/, /team_merge/, /team_review/]) {
    assert.doesNotMatch(await systemOf(sub.id), omitted, 'a subagent is never told lead or visit instructions');
  }
  assert.doesNotMatch(await systemOf(sub.id), /\n{3,}/, 'no gap where it would have been');

  // An owner's own system prompt from before visits still tells a worker about them.
  system = 'You are {{name}}, at a desk.';
  const custom = workers.spawn('desk-4', 'test', 'read');
  if (typeof custom === 'string') return assert.fail(custom);
  assert.match(await systemOf(custom.id), /^You are .*, at a desk\.\n\n- Use `visit_roster`/);

  // A saved custom prompt with verbatim lead and visit paragraphs still scrubs both for a subagent.
  system = `You are {{name}}.\n\n${WORKER_TEAM_LEAD}\n\n${WORKER_VISITS}\n\nFinish cleanly.`;
  const legacySub = workers.spawn('desk-6', 'test', 'help out', false, 'agent', undefined, undefined, [], lead.id);
  if (typeof legacySub === 'string') return assert.fail(legacySub);
  assert.match(await systemOf(legacySub.id), /`team_board`/);
  assert.doesNotMatch(await systemOf(legacySub.id), /team_hire|visit_roster/);
  assert.doesNotMatch(await systemOf(legacySub.id), /\n{3,}/);

  on = false;
  system = PROMPTS['worker.system'].text;
  const off = workers.spawn('desk-5', 'test', 'read');
  if (typeof off === 'string') return assert.fail(off);
  assert.doesNotMatch(await systemOf(off.id), /visit_roster/);
});
test("a plain folder's daemon workers start there with no branch policy or worktrees", async (t) => {
  const f = fixture();
  isolateAgentEnvironment(f, t);
  const previousLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (previousLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = previousLog;
    f.close();
  });
  // Inside someone else's checkout, as a docs folder in a repository is.
  execFileSync('git', ['init', '-q', '-b', 'main', f.root]);
  const folder = path.join(f.root, 'notes');
  const data = path.join(folder, '.droid-office');
  mkdirSync(data, { recursive: true });
  const workers = managed(f, folder, data, f.droid, [], { url: 'http://127.0.0.1:1', token: '' }, events([]), undefined, undefined, undefined, true);
  t.after(() => workers.shutdown());
  assert.equal(existsSync(path.join(data, 'floor-branch.json')), false, 'plain floors have no branch setting');

  assert.match(String(workers.spawn('desk-2', 'test', 'branch out', true)), /plain folder.*can't have worktrees/);
  assert.equal(workers.spawn('station-issues', 'test', 'triage'), 'Unknown desk');
  assert.equal(workers.spawn('station-actions', 'test', 'heal'), 'Unknown desk');

  const w = workers.spawn('desk-2', 'test', 'tidy the notes');
  if (typeof w === 'string') return assert.fail(w);
  const launch = await initializedWorker(f, w.id);
  assert.equal(launch.options.cwd, folder);
  const system = launch.options.workerSystemPrompt ?? '';
  assert.match(system, new RegExp(`^You're ${w.name}, a worker in Droid Office`));
  assert.doesNotMatch(system, /floor branch|floor-branch\.json|git fetch/);
  assert.doesNotMatch(system, /\n{3,}/, 'no gap where the branch policy was');
});

test('a worker nobody picked for starts on the office default worker', async (t) => {
  const f = fixture();
  isolateAgentEnvironment(f, t);
  const previousLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (previousLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = previousLog;
    f.close();
  });
  let agent: AgentChoice | undefined = { model: 'custom:droidproxy:opus-5-5', effort: 'high' };
  const prompts: PromptSource = { text: (id) => PROMPTS[id].text, agent: () => agent };
  const workers = managed(f, f.root, f.data, f.droid, [], { url: 'http://127.0.0.1:1', token: '' }, events([]), undefined, undefined, prompts);
  t.after(() => workers.shutdown());
  assert.deepEqual(workers.officeDefault, agent);

  const info = workers.spawn('desk-4', 'Ada', 'Sum up the open PRs');
  if (typeof info === 'string') return assert.fail(info);
  const r = { info };
  if (typeof r === 'string') return assert.fail(r);
  assert.deepEqual([r.info.model, r.info.effort], ['custom:droidproxy:opus-5-5', 'high']);
  const launch = await initializedWorker(f, r.info.id);
  await waitFor(() => f.daemon.messages.find((m) => m.sessionId === launch.sessionId)?.text, Boolean);
  assert.equal(f.daemon.messages[0].text, 'Sum up the open PRs');
  assert.equal(launch.options.modelId, 'custom:droidproxy:opus-5-5');
  assert.equal(launch.options.reasoningEffort, 'high');

  // A picked model wins, and a shell is never given one.
  const picked = workers.spawn('desk-1', 'Ada', 'fix it', false, 'agent', 'glm-5.3-flash');
  if (typeof picked === 'string') return assert.fail(picked);
  assert.deepEqual([picked.model, picked.effort], ['glm-5.3-flash', undefined]);
  const shell = workers.spawn('desk-2', 'Ada', undefined, false, 'shell');
  if (typeof shell === 'string') return assert.fail(shell);
  assert.deepEqual([shell.model, shell.effort], [undefined, undefined], 'a shell is never given one');
  // Unset, it's Droid's own default model as before.
  agent = undefined;
  const plain = workers.spawn('desk-3', 'Ada', 'fix that');
  if (typeof plain === 'string') return assert.fail(plain);
  assert.deepEqual([plain.model, plain.effort], [undefined, undefined]);
});

test('workers reject malformed model ids, unknown efforts, and models or efforts on shells', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  assert.match(workers.spawn('desk-1', 'test', 'bad', false, 'agent', 'has a space') as string, /Droid model/i);
  assert.match(workers.spawn('desk-2', 'test', 'bad', false, 'agent', undefined, 'overdrive' as AgentEffort) as string, /effort/i);
  assert.match(workers.spawn('desk-3', 'test', 'bad', false, 'shell', 'glm-5.3-flash') as string, /shell/i);
  assert.match(workers.spawn('desk-4', 'test', 'bad', false, 'shell', undefined, 'high' as AgentEffort) as string, /shell/i);
});

test('a saved worker comes back with a valid model, without an invalid one', (t) => {
  const f = fixture();
  t.after(() => f.close());
  writeFileSync(
    path.join(f.data, 'workers.json'),
    JSON.stringify([
      { id: 'kept', kind: 'agent', deskId: 'desk-1', name: 'Kept', model: 'glm-5.3-flash', sessionId: 'd-1', hookToken: 'kept-token' },
      { id: 'kept-bad', kind: 'agent', deskId: 'desk-2', name: 'Bad', model: 'has a space' },
      { id: 'shell-kept', kind: 'shell', deskId: 'desk-4', name: 'Shell' },
    ]),
  );
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  assert.deepEqual(
    workers
      .list()
      .map((w) => w.id)
      .sort(),
    ['kept', 'kept-bad', 'shell-kept'],
  );
  assert.equal(workers.get('kept')?.model, 'glm-5.3-flash');
  assert.equal(workers.get('kept-bad')?.model, undefined);
});

test('workers at removed seats are not resumed and their saved work is preserved', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const retired = {
    id: 'retired',
    kind: 'agent',
    deskId: 'meeting-1',
    name: 'Retired',
    sessionId: 'saved-session',
    worktree: { path: '.droid-office/worktrees/old-room', branch: 'office/old-room', base: 'main' },
  };
  const state = path.join(f.data, 'workers.json');
  writeFileSync(state, JSON.stringify([retired]));
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  await workers.start();
  assert.deepEqual(workers.list(), []);
  assert.equal(workers.spawn('meeting-1', 'test'), 'Unknown desk');
  assert.deepEqual(f.read(), [], 'no agent starts at a removed seat');
  workers.shutdown();
  assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')), [retired]);
});

test('Finder dispatch reuses an ordinary worker session, refuses busy turns, and changes the model in place', async (t) => {
  const f = fixture();
  isolateAgentEnvironment(f, t);
  const previousLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (previousLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = previousLog;
    f.close();
  });
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  const launches = () => f.daemon.launches;
  const prompt = 'Inspect token refresh\n\n"/selected/auth.ts"';
  const hired = await workers.dispatchWorker(prompt, 'gpt-6.1-sol');
  assert.equal(typeof hired, 'object');
  if (typeof hired === 'string') return;
  assert.equal(hired.hired, true);
  assert.equal(hired.info.deskId, 'desk-1');
  assert.equal(hired.info.createdBy, 'Finder');
  assert.equal(hired.info.lead, undefined);
  const first = await initializedWorker(f, hired.info.id);
  const initial = await waitFor(() => f.daemon.messages[0]?.text, Boolean);
  assert.equal(initial, prompt);
  assert.ok(initial.endsWith(prompt));
  assert.doesNotMatch(initial, /Finder orchestrator|finder-specific|Dispatch Flow/);
  assert.match((await workers.dispatchWorker('Another request')) as string, /busy/);
  const info = workers.get(hired.info.id)!;
  info.status = 'working';
  info.lastInputAt = Date.now() - 3000;
  assert.match((await workers.dispatchWorker('Still working')) as string, /busy/);
  info.status = 'needs_input';
  assert.match((await workers.dispatchWorker('Not an answer')) as string, /busy/);
  info.status = 'done';
  info.lastInputAt = Date.now() - 3000;
  info.worktree = { path: '.droid-office/worktrees/missing-finder', branch: 'missing-finder', base: 'main' };
  assert.equal(typeof (await workers.dispatchWorker('Cannot switch a lost checkout', 'glm-5.3-flash')), 'string');
  assert.equal(info.model, 'gpt-6.1-sol');
  assert.equal(launches().length, 1);
  info.worktree = undefined;
  info.lost = undefined;
  const again = await workers.dispatchWorker('Follow up', 'gpt-6.1-sol');
  assert.deepEqual(typeof again === 'object' && [again.hired, again.info.id], [false, info.id]);
  await waitFor(() => f.daemon.messages.some((m) => m.sessionId === first.sessionId && m.text === 'Follow up'), Boolean);
  info.status = 'done';
  info.lastInputAt = Date.now() - 3000;
  const setting = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  t.after(() => setting.resolve());
  const update = f.daemon.updateSessionSettings.bind(f.daemon);
  const stub = t.mock.method(f.daemon, 'updateSessionSettings', async (params) => {
    entered.resolve();
    await setting.promise;
    await update(params);
  });
  const dispatch = workers.dispatchWorker('Use the other model', 'glm-5.3-flash');
  await entered.promise;
  assert.equal(f.daemon.messages.length, 2, 'Finder waits for the daemon to apply the model');
  assert.match((await workers.dispatchWorker('Overlapping request')) as string, /busy/);
  setting.resolve();
  const changed = await dispatch;
  assert.deepEqual(typeof changed === 'object' && [changed.hired, changed.info.id], [false, info.id]);
  assert.deepEqual(f.daemon.settingsChanges, [{ sessionId: first.sessionId, modelId: 'glm-5.3-flash' }]);
  assert.equal(workers.get(info.id)?.model, 'glm-5.3-flash');
  await waitFor(() => f.daemon.messages.some((m) => m.sessionId === first.sessionId && m.text === 'Use the other model'), Boolean);
  assert.equal(launches().length, 1);
  stub.mock.restore();
  t.mock.method(f.daemon, 'updateSessionSettings', async () => {
    throw new Error('The daemon refused that model');
  });
  info.status = 'done';
  info.lastInputAt = Date.now() - 3000;
  assert.equal(await workers.dispatchWorker('Do not send under the wrong model', 'gpt-6.1-sol'), 'The daemon refused that model');
  assert.equal(f.daemon.messages.length, 3);
  assert.equal(info.model, 'glm-5.3-flash');
});

test('an office-queue command an older office left behind is cleared away, and ordinary workers get no legacy command', async (t) => {
  const f = fixture();
  isolateAgentEnvironment(f, t);
  const previousLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (previousLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = previousLog;
    f.close();
  });
  const bin = path.join(f.data, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'office-queue'), '#!/bin/sh\n');
  writeFileSync(path.join(bin, 'office-queue.cmd'), '@echo off\r\n');
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  assert.equal(existsSync(path.join(bin, 'office-queue')), false);
  assert.equal(existsSync(path.join(bin, 'office-queue.cmd')), false);
  assert.equal(existsSync(path.join(bin, 'team')), false);

  const info = workers.spawn('desk-1', 'Ada', 'Kick off the release workflow');
  if (typeof info === 'string') return assert.fail(info);
  const hired = { info };
  assert.equal(typeof hired, 'object');
  if (typeof hired === 'string') return;
  assert.ok(NAMES.includes(hired.info.name));
  await initializedWorker(f, hired.info.id);
  assert.equal(existsSync(path.join(bin, 'office-queue')), false);
  assert.equal(existsSync(path.join(bin, 'team')), false);
});

test('structured asks revalidate menus, report waiting timestamps and deliver a whole questionnaire', async (t) => {
  const f = carryOnFixture(t);
  const workers = manager(f, []);
  const worker = await hireInState(f, workers, 'desk-1', 'ask-session', 'working');
  const sid = worker.sessionId!;
  const clock = t.mock.timers;
  clock.enable({ apis: ['Date'], now: Date.now() + 1000 });
  assert.equal(worker.waitingSince, undefined);
  const questions = [
    { index: 1, question: 'Which color?', options: ['Red', 'Blue'], multiSelect: false },
    { index: 2, question: 'Which sizes?', options: ['S', 'M'], multiSelect: true },
  ];
  f.daemon.ask(sid, { requestId: 'question', toolCallId: 'ask-tool', questions });
  const first = worker.menu!;
  assert.equal(first.question, questions[0].question);
  assert.equal(worker.waitingSince, Date.now());
  assert.equal(worker.activity, 'Which color? (+1 more)');
  assert.equal(workers.open(worker.id, 'thread'), true);
  assert.equal(worker.acked, false, 'opening does not answer it');
  assert.equal(workers.answerQuestion(worker.id, { ...first, question: 'An unrelated question' }, { choice: 1 }) !== undefined, true);
  assert.deepEqual(f.daemon.answers, []);
  assert.equal(workers.answerQuestion(worker.id, first, { choice: 2 }), undefined);
  assert.equal(worker.menu?.question, questions[1].question);
  assert.deepEqual(f.daemon.answers, [], 'Droid gets one reply for the whole questionnaire');
  assert.equal(workers.answerQuestion(worker.id, worker.menu!, { choices: [1, 2] }), undefined);
  assert.deepEqual(f.daemon.answers, [
    {
      sessionId: sid,
      answers: [
        { index: 1, question: 'Which color?', answer: 'Blue' },
        { index: 2, question: 'Which sizes?', answer: 'S, M' },
      ],
    },
  ]);
  assert.equal(worker.menu, undefined);
  const start = Date.now();
  clock.setTime(start + 1);
  f.daemon.notify(sid, { type: 'agent_turn_completed' });
  assert.equal(worker.waitingSince, start + 1, 'finishing starts a new wait');
  assert.equal(worker.status, 'done');
  assert.equal(workers.open(worker.id, 'another-thread'), true);
  assert.equal(worker.acked, true, 'opening a finished Thread acknowledges it');
});

test('tool notifications animate work, count failed tests and request branch/PR refreshes', async (t) => {
  const f = carryOnFixture(t);
  const refreshed: ToolRefresh[] = [];
  const workers = managed(f, f.root, f.data, f.droid, [], { url: 'http://127.0.0.1:1', token: '' }, { ...events([]), tool: (_id, refresh) => refreshed.push(refresh) });
  const worker = await hireInState(f, workers, 'desk-1', 'tools', 'working');
  const sid = worker.sessionId!;
  let n = 0;
  const call = (toolName: string, input: Record<string, unknown>) => {
    const toolUseId = `tool-${++n}`;
    f.daemon.notify(sid, { type: 'tool_call', toolUse: { name: toolName, id: toolUseId, input } });
    return (content = '', isError = false) => f.daemon.notify(sid, { type: 'tool_result', toolResult: { tool_use_id: toolUseId, content, is_error: isError } });
  };
  const read = call('Read', { file_path: 'src/a.ts' });
  assert.equal(worker.action, 'read');
  read();
  const edit = call('Edit', { file_path: 'src/a.ts' });
  assert.equal(worker.action, 'edit');
  edit();
  call('Execute', { command: 'git push -u origin HEAD' })();
  assert.deepEqual(refreshed, [{ changes: true }, { changes: true, board: true, pipelines: true }]);
  const run = () => call('Execute', { command: 'npm test' });
  run()('# tests 5\n# pass 3\n# fail 2');
  assert.equal(worker.action, 'test');
  run()('Exit code 1', true);
  assert.equal(worker.action, 'failing');
  run()('# tests 5\n# pass 5\n# fail 0');
  run()('Exit code 1', true);
  assert.equal(worker.action, 'test', 'a passing run reset the count');
  f.daemon.notify(sid, { type: 'agent_turn_completed' });
  assert.equal(worker.action, undefined);
});

test('a child session cannot finish the parent, and a new conversation drops its routes and task preview', async (t) => {
  const f = carryOnFixture(t);
  const workers = manager(f, []);
  const worker = await hireInState(f, workers, 'desk-1', 'parent', 'working');
  f.daemon.notify('parent', { type: 'child_session_available', childSessionId: 'child', toolUseId: 'task' });
  f.daemon.notify('child', { type: 'agent_turn_completed' });
  assert.equal(worker.status, 'working');
  assert.equal(worker.sessionId, 'parent');
  assert.deepEqual(f.daemon.interrupts, []);
  assert.equal(workers.cancelTurn(worker.id), true);
  assert.deepEqual(f.daemon.interrupts, ['parent']);
  f.daemon.notify('parent', { type: 'agent_turn_completed', reason: 'interrupted' });
  assert.equal(workers.cancelTurn(worker.id), false);
  assert.ok(worker.task);
  assert.equal(workers.prompt(worker.id, '/clear'), undefined);
  await waitFor(
    () => worker.sessionId,
    (sid) => !!sid && sid !== 'parent',
  );
  await waitFor(
    () => worker.status,
    (status) => status === 'idle',
  );
  assert.equal(worker.task, undefined);
  assert.ok(worker.taskSince);
  const answer = { requestId: 'old-ask', toolCallId: 'task', questions: [{ index: 1, question: 'Old question?', options: ['Yes'], multiSelect: false }] };
  f.daemon.ask('parent', answer);
  f.daemon.ask('child', answer);
  assert.equal(worker.menu, undefined, 'neither the old session nor its child is allowed to change the new one');
  workers.shutdown();
  const restored = manager(f, []);
  assert.equal(restored.get(worker.id)?.prompt, 'task for parent', 'the historic hire prompt is still retained');
  assert.equal(restored.get(worker.id)?.task, undefined, 'restarting does not bring back the old preview');
});
function carryOnFixture(t: { after(fn: () => void): void }) {
  const f = fixture();
  isolateAgentEnvironment(f, t);
  const oldLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (oldLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = oldLog;
    f.close();
  });
  return f;
}

test('fixture cleanup shuts down every manager before deleting its directory', async (t) => {
  const f = carryOnFixture(t);
  const updates: WorkerInfo[] = [];
  const workers = manager(f, updates);
  const pending = Promise.withResolvers<void>();
  t.after(() => pending.resolve());
  f.daemon.beforeInitialize = () => pending.promise;
  const worker = workers.spawn('desk-1', 'test', 'never sent');
  if (typeof worker === 'string') return assert.fail(worker);
  await initializedWorker(f, worker.id);
  const restored = manager(f, []);
  const stopped: WorkerManager[] = [];
  for (const current of [workers, restored]) {
    const shutdown = current.shutdown.bind(current);
    t.mock.method(current, 'shutdown', () => {
      assert.ok(existsSync(f.root), 'shutdown may still write its final state');
      stopped.push(current);
      shutdown();
    });
  }
  f.close();
  assert.deepEqual(stopped, [workers, restored]);
  assert.equal(existsSync(f.root), false);
  t.mock.restoreAll();
  const updateCount = updates.length;
  pending.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(existsSync(f.root), false, 'late daemon replies must not recreate the fixture');
  assert.equal(updates.length, updateCount);
  assert.equal(worker.sessionId, undefined);
  assert.deepEqual(f.daemon.messages, []);
});

/** Hires a worker and puts its session in `state`: mid-turn ('working', 'needs_input') or finished ('done'). */
async function hireInState(f: Fixture, workers: WorkerManager, deskId: string, session: string, state: 'working' | 'needs_input' | 'done') {
  f.daemon.nextSessionId = session;
  const worker = workers.spawn(deskId, 'test', `task for ${session}`);
  if (typeof worker === 'string') throw new Error(worker);
  await waitFor(() => f.daemon.messages.some((message) => message.sessionId === session), Boolean);
  if (state === 'needs_input') f.daemon.ask(session, { requestId: 'ask-1', toolCallId: 'ask-tool', questions: [{ index: 1, question: 'Which color?', options: ['Red', 'Blue'], multiSelect: false }] });
  if (state === 'done') f.daemon.notify(session, { type: 'agent_turn_completed' });
  assert.equal(workers.get(worker.id)?.status, state);
  return worker;
}

/** A local repository for fork tests, with no dependencies to install and no runtime state to copy. */
function forkRepository(f: Fixture, dir = f.root) {
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  mkdirSync(dir, { recursive: true });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, '.gitignore'), '.droid-office/\ndata/\nbin/\nhome/\nconfig/\nother/\nxdg-*/\n*.jsonl\n.env\n');
  writeFileSync(path.join(dir, '.droid-office.json'), JSON.stringify({ worktree: { setup: '', copy: ['/.env'] } }));
  writeFileSync(path.join(dir, 'file.txt'), 'committed');
  git('add', '.');
  git('commit', '-qm', 'init');
  return git;
}

for (const nested of [false, true]) {
  test(`a fork on ${nested ? 'a plain folder inside a checkout' : 'Home'} shares the folder without git or worktree setup and resumes its own session`, async (t) => {
    const f = carryOnFixture(t);
    if (nested) execFileSync('git', ['init', '-q', '-b', 'main', f.root]);
    const folder = path.join(f.root, nested ? 'notes' : 'home');
    const data = path.join(folder, '.droid-office');
    mkdirSync(data, { recursive: true });
    writeFileSync(path.join(folder, 'notes.txt'), 'shared notes');
    const createManager = () => managed(f, folder, data, f.droid, [], { url: 'http://127.0.0.1:1', token: '' }, events([]), undefined, undefined, undefined, true);
    const workers = createManager();
    const source = await hireInState(f, workers, 'desk-1', 'source-home', 'done');
    const fork = t.mock.method(Worktrees.prototype, 'fork', () => assert.fail('plain forks must not call git'));
    const ownership = t.mock.method(Worktrees.prototype, 'ownership', () => assert.fail('plain forks have no branch ownership'));
    const twin = await workers.fork(source.id, 'test', 'Try another approach');
    assert.ok(typeof twin !== 'string', String(twin));
    if (typeof twin === 'string') return;
    assert.equal(twin.worktree, undefined);
    assert.equal(twin.repos, undefined);
    assert.equal(twin.lead, undefined);
    assert.equal(twin.forkedFrom?.workerId, source.id);
    assert.equal(twin.deskId, 'desk-3');
    const sid = await waitFor(() => twin.sessionId, Boolean);
    const forkRequest = f.daemon.forks.find((fork) => fork.loadOptions?.mcp?.workerId === twin.id);
    assert.equal(forkRequest?.sessionId, source.sessionId);
    assert.equal(forkRequest?.cwd && realpathSync(forkRequest.cwd), realpathSync(folder));
    assert.equal(existsSync(path.join(data, 'worktrees')), false);
    const saved = JSON.parse(readFileSync(path.join(data, 'workers.json'), 'utf8')).find((w: WorkerInfo) => w.id === twin.id);
    assert.equal(saved.setupPlan, undefined);
    assert.equal(saved.worktreeOwnership, undefined);
    assert.equal(saved.pendingFork, undefined);
    assert.equal(await waitFor(() => f.daemon.messages.find((m) => m.sessionId === sid)?.text, Boolean), 'Try another approach');
    assert.notEqual(source.sessionId, sid);
    assert.equal(readFileSync(path.join(folder, 'notes.txt'), 'utf8'), 'shared notes');
    workers.shutdown(true);
    const after = createManager();
    assert.equal(after.resume(twin.id), undefined);
    const resumed = f.daemon.launches.at(-1)!;
    assert.equal(resumed.sessionId, sid);
    assert.equal(resumed.options.mcp?.workerId, twin.id);
    assert.equal(fork.mock.callCount(), 0);
    assert.equal(ownership.mock.callCount(), 0);
  });
}

test('a fork gets its own session, worktree, source-local setup and seat, then resumes only its own id', async (t) => {
  const f = carryOnFixture(t);
  const git = forkRepository(f);
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  workers.holds = { desk: (id) => id === 'desk-3', names: () => [] };
  const source = await hireInState(f, workers, 'desk-1', 'source-session', 'done');
  writeFileSync(path.join(f.root, 'file.txt'), 'staged');
  git('add', 'file.txt');
  writeFileSync(path.join(f.root, 'file.txt'), 'unstaged');
  writeFileSync(path.join(f.root, '.env'), 'LOCAL=source');
  const twin = await workers.fork(source.id, 'test', 'Try the alternative');
  assert.ok(typeof twin !== 'string', String(twin));
  if (typeof twin === 'string') return;
  assert.equal(twin.deskId, 'desk-2', 'the nearest desk is held');
  assert.equal(twin.name, `${source.name} ⑂`);
  assert.equal(twin.color, source.color);
  assert.notEqual(twin.sessionId, source.sessionId, 'never claims the source session');
  assert.equal(twin.lead, undefined, 'a peer, not a subagent');
  assert.equal(twin.worktree?.base, git('rev-parse', 'HEAD'));
  assert.equal(twin.forkedFrom?.workerId, source.id);
  const sid = await waitFor(() => twin.sessionId, Boolean);
  const request = f.daemon.forks.at(-1)!;
  assert.equal(request.sessionId, source.sessionId);
  const cwd = path.join(f.root, twin.worktree!.path);
  assert.equal(realpathSync(request.cwd!), realpathSync(cwd), 'the fork is moved into its own worktree');
  assert.equal(readFileSync(path.join(cwd, 'file.txt'), 'utf8'), 'unstaged');
  assert.equal(readFileSync(path.join(cwd, '.env'), 'utf8'), 'LOCAL=source');
  assert.equal(await waitFor(() => f.daemon.messages.find((m) => m.sessionId === sid)?.text, Boolean), 'Try the alternative');
  assert.notEqual(twin.sessionId, source.sessionId);
  const saved = JSON.parse(readFileSync(path.join(f.data, 'workers.json'), 'utf8')).find((w: WorkerInfo) => w.id === twin.id);
  assert.equal(saved.pendingFork, undefined);
  workers.shutdown(true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const after = manager(f, []);
  t.after(() => after.shutdown());
  assert.deepEqual(after.get(twin.id)?.forkedFrom, twin.forkedFrom);
  assert.equal(after.resume(twin.id), undefined);
  assert.equal(f.daemon.launches.at(-1)?.sessionId, sid);
  assert.equal(f.daemon.launches.at(-1)?.options.mcp?.workerId, twin.id);
});

test('an interrupted fork retries the fork RPC, never loading the source as its own session', async (t) => {
  const f = carryOnFixture(t);
  forkRepository(f);
  const before = manager(f, []);
  const source = await hireInState(f, before, 'desk-1', 'source-pending', 'done');
  const pending = Promise.withResolvers<void>();
  t.after(() => pending.resolve());
  f.daemon.beforeFork = () => pending.promise;
  const twin = await before.fork(source.id, 'test', 'alternative after restart');
  if (typeof twin === 'string') return assert.fail(twin);
  await waitFor(
    () => f.daemon.forks.length,
    (n) => n === 1,
  );
  assert.equal(twin.sessionId, undefined);
  before.shutdown(true);
  f.daemon.beforeFork = undefined;
  const after = manager(f, []);
  assert.equal(after.resume(twin.id), undefined);
  const sid = await waitFor(() => after.get(twin.id)?.sessionId, Boolean);
  pending.resolve();
  assert.notEqual(sid, source.sessionId);
  assert.deepEqual(
    f.daemon.forks.map((fork) => fork.sessionId),
    [source.sessionId, source.sessionId],
  );
  assert.equal(await waitFor(() => f.daemon.messages.find((m) => m.sessionId === sid)?.text, Boolean), 'alternative after restart');
});
test('a fork copies every repository in a workspace and leaves team relationships behind', async (t) => {
  const f = carryOnFixture(t);
  forkRepository(f);
  const other = path.join(f.root, 'other');
  forkRepository(f, other);
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  const source = workers.spawn('desk-1', 'test', undefined, true, 'agent', undefined, undefined, [{ floor: 'other', name: 'other', dir: other }]);
  assert.ok(typeof source !== 'string', String(source));
  if (typeof source === 'string') return;
  await waitFor(
    () => source.status,
    (status) => status === 'idle',
  );
  writeFileSync(path.join(f.root, source.worktree!.path, 'file.txt'), 'primary edits');
  writeFileSync(path.join(f.root, source.repos![0].path, 'file.txt'), 'other edits');
  writeFileSync(path.join(f.root, '.env'), 'LOCAL=floor');
  writeFileSync(path.join(f.root, source.worktree!.path, '.env'), 'LOCAL=source');
  writeFileSync(path.join(f.root, source.repos![0].path, '.env'), 'LOCAL=other-source');
  source.activeModel = 'custom:current';
  source.effort = 'high';
  source.activeEffort = undefined;
  const twin = await workers.fork(source.id, 'test');
  assert.ok(typeof twin !== 'string', String(twin));
  if (typeof twin === 'string') return;
  assert.equal(readFileSync(path.join(f.root, twin.worktree!.path, 'file.txt'), 'utf8'), 'primary edits');
  assert.equal(readFileSync(path.join(f.root, twin.repos![0].path, 'file.txt'), 'utf8'), 'other edits');
  assert.equal(twin.repos![0].floor, 'other');
  assert.notEqual(twin.repos![0].path, source.repos![0].path);
  assert.equal(twin.lead, undefined);
  assert.equal(twin.team, undefined);
  assert.equal(twin.model, 'custom:current');
  assert.equal(twin.effort, undefined, 'a /model change without effort must not inherit an old pinned effort');
  await waitFor(
    () => twin.status,
    (status) => status === 'idle',
  );
  assert.equal(
    f.daemon.messages.some((m) => m.sessionId === twin.sessionId),
    false,
    'a blank fork never starts a turn',
  );
  assert.equal(readFileSync(path.join(f.root, twin.worktree!.path, '.env'), 'utf8'), 'LOCAL=source');
  assert.equal(readFileSync(path.join(f.root, twin.repos![0].path, '.env'), 'utf8'), 'LOCAL=other-source');
  const another = await workers.fork(source.id, 'test');
  assert.ok(typeof another !== 'string', String(another));
  if (typeof another === 'string') return;
  assert.equal(another.name, `${source.name} ⑂ 2`);
  rmSync(path.join(f.root, source.repos![0].path), { recursive: true, force: true });
  const beforeBranches = execFileSync('git', ['branch', '--format=%(refname)'], { cwd: f.root, encoding: 'utf8' });
  assert.match(String(await workers.fork(source.id, 'test')), /not a worktree/);
  assert.equal(execFileSync('git', ['branch', '--format=%(refname)'], { cwd: f.root, encoding: 'utf8' }), beforeBranches, 'a failure in the second repository removes the first new branch');
  assert.equal(workers.list().length, 3, 'a failed fork seats nobody');
});

test('forks refuse busy workers, missing sessions, missing sources, full offices and occupied floors before making worktrees', async (t) => {
  const f = carryOnFixture(t);
  forkRepository(f);
  let limited = false;
  const workers = managed(f, f.root, f.data, f.droid, [], { url: 'http://127.0.0.1:1', token: '' }, events([]), {
    full: () => (limited ? 'The office is at its limit' : undefined),
    room: () => (limited ? 0 : 1),
  });
  t.after(() => workers.shutdown());
  const source = await hireInState(f, workers, 'desk-1', 'guarded-source', 'working');
  assert.match(String(await workers.fork(source.id, 'test')), /turn ends/);
  source.status = 'needs_input';
  assert.match(String(await workers.fork(source.id, 'test')), /turn ends/);
  source.status = 'done';
  source.sessionId = undefined;
  assert.match(String(await workers.fork(source.id, 'test')), /session to start/);
  source.sessionId = 'guarded-source';
  limited = true;
  assert.match(String(await workers.fork(source.id, 'test')), /at its limit/);
  limited = false;
  assert.match(String(await workers.fork('missing', 'test')), /No such worker/);
  source.deskId = 'retired-desk';
  assert.match(String(await workers.fork(source.id, 'test')), /source desk is no longer/);
  source.deskId = 'desk-1';
  workers.holds = { desk: () => true, names: () => [] };
  assert.match(String(await workers.fork(source.id, 'test')), /Every desk/);
  assert.equal(workers.list().length, 1);
  assert.equal(existsSync(path.join(f.root, '.droid-office', 'worktrees')), false);
});

test('restart reloads a vanished daemon session and carries on only the interrupted turn', async (t) => {
  const f = carryOnFixture(t);
  const before = manager(f, []);
  const working = await hireInState(f, before, 'desk-1', 'restart-working', 'working');
  const done = await hireInState(f, before, 'desk-2', 'restart-done', 'done');
  before.shutdown(true);
  f.daemon.stop();
  const after = manager(f, []);
  await after.start();
  assert.equal(after.get(working.id)?.sessionId, working.sessionId);
  assert.equal(after.get(done.id)?.sessionId, done.sessionId);
  assert.equal(after.get(done.id)?.status, 'done');
  assert.deepEqual(
    f.daemon.messages.slice(2).map((m) => [m.sessionId, m.text]),
    [[working.sessionId, CARRY_ON_PROMPT]],
  );
});

test('a working daemon session and a pending AskUser keep their state across an office restart', async (t) => {
  const f = carryOnFixture(t);
  const before = manager(f, []);
  const working = await hireInState(f, before, 'desk-1', 'kept-working', 'working');
  f.daemon.notify(working.sessionId!, { type: 'droid_working_state_changed', newState: 'thinking' });
  const asking = await hireInState(f, before, 'desk-2', 'kept-asking', 'needs_input');
  assert.equal(before.hold(asking.id, 'Look at the board'), undefined);
  before.shutdown(true);
  const reopened = manager(f, []);
  await reopened.start();
  assert.equal(f.daemon.launches.length, 2, 'neither open session was relaunched');
  assert.equal(reopened.get(working.id)?.status, 'working');
  assert.equal(reopened.get(asking.id)?.status, 'needs_input');
  assert.equal(reopened.get(asking.id)?.menu?.question, 'Which color?');
  assert.equal(
    f.daemon.messages.some((m) => m.text.includes(CARRY_ON_PROMPT)),
    false,
  );
  assert.equal(f.daemon.messages.slice(2).filter((m) => m.text.includes('Look at the board')).length, 1);
});
test('a turn that finished while the office was down comes back done and unread', async (t) => {
  const f = carryOnFixture(t);
  const before = manager(f, []);
  const working = await hireInState(f, before, 'desk-1', 'finished-while-down', 'working');
  f.daemon.notify(working.sessionId!, { type: 'droid_working_state_changed', newState: 'thinking' });
  before.shutdown(true);
  f.daemon.notify(working.sessionId!, { type: 'agent_turn_completed', reason: 'completed' });
  const reopened = manager(f, []);
  t.after(() => reopened.shutdown());
  await reopened.start();
  assert.equal(reopened.get(working.id)?.status, 'done');
  assert.equal(reopened.get(working.id)?.acked, false);
  assert.equal(typeof reopened.get(working.id)?.waitingSince, 'number');
  assert.equal(
    f.daemon.messages.some((m) => m.text.includes(CARRY_ON_PROMPT)),
    false,
    'a session that stayed open is never told to carry on',
  );
});

test('an upgrade retires the four kiosk seats and preserves ordinary workers, subworkers and their worktrees', async (t) => {
  const f = carryOnFixture(t);
  const before = manager(f, []);
  await before.start();
  const removed = [];
  const stations = ['station-issues', 'station-pulls', 'station-actions', 'station-lead'];
  for (const [i, deskId] of stations.entries()) {
    const w = await hireInState(f, before, `desk-${i + 1}`, `legacy-${i}`, 'working');
    w.deskId = deskId;
    removed.push(w);
  }
  const root = await hireInState(f, before, 'desk-5', 'ordinary-root', 'working');
  const bag = await hireInState(f, before, 'beanbag-1', 'ordinary-bag', 'working');
  const sub = await hireInState(f, before, 'desk-6', 'ordinary-sub', 'working');
  sub.lead = root.id;
  const orphan = await hireInState(f, before, 'desk-7', 'retired-lead-sub', 'working');
  orphan.lead = removed[3].id;
  const history = path.join(f.data, 'worktrees', 'legacy-history');
  mkdirSync(history, { recursive: true });
  const note = path.join(history, 'uncommitted-notes.txt');
  writeFileSync(note, 'Keep user work');
  sub.worktree = { path: path.relative(f.root, history), branch: 'office/legacy-history', base: 'main' };
  before.shutdown(true);
  const after = manager(f, []);
  t.after(() => after.shutdown());
  await after.start();
  assert.deepEqual(new Set(after.list().map((w) => w.id)), new Set([root.id, bag.id, sub.id, orphan.id]));
  assert.equal(after.get(sub.id)?.lead, root.id);
  assert.equal(after.get(orphan.id)?.lead, undefined, 'a retired kiosk lead does not remove its ordinary subworker');
  assert.equal(f.daemon.launches.length, 8, 'ordinary daemon sessions are adopted, not relaunched');
  assert.equal(readFileSync(note, 'utf8'), 'Keep user work');
});

test('a first prompt not yet sent to the daemon survives a graceful restart', async (t) => {
  const f = carryOnFixture(t);
  const before = manager(f, []);
  const pending = Promise.withResolvers<void>();
  t.after(() => pending.resolve());
  f.daemon.beforeInitialize = () => pending.promise;
  const worker = before.spawn('desk-1', 'test', 'fix the login');
  if (typeof worker === 'string') return assert.fail(worker);
  await initializedWorker(f, worker.id);
  assert.equal(worker.sessionId, undefined);
  assert.deepEqual(f.daemon.messages, []);
  before.shutdown(true);
  f.daemon.beforeInitialize = undefined;
  const after = manager(f, []);
  await after.start();
  await waitFor(
    () => f.daemon.messages.length,
    (n) => n === 1,
  );
  pending.resolve();
  assert.equal(f.daemon.messages[0].text, 'fix the login');
  assert.equal(f.daemon.messages[0].sessionId, after.get(worker.id)?.sessionId);
  after.shutdown(true);
  const again = manager(f, []);
  await again.start();
  assert.equal(f.daemon.messages.length, 1, 'adoption does not repeat delivered prompts');
});
test('a worker whose terminal was in the host when an older office went down carries on if the host is gone', async (t) => {
  const f = carryOnFixture(t);
  // workers.json as the office before midTurn left it: only the host terminal's status says it was mid-turn.
  const saved = (id: string, deskId: string, sessionId: string, status: string) => ({
    id,
    kind: 'agent',
    deskId,
    name: id,
    sessionId,
    hookToken: `${id}-token`,
    pty: { id: `${id}-pty`, status, acked: true },
  });
  writeFileSync(path.join(f.data, 'workers.json'), JSON.stringify([saved('upgraded', 'desk-1', 'was-working', 'working'), saved('idle', 'desk-2', 'was-done', 'done')]));
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  await workers.start();
  assert.deepEqual(
    f.daemon.launches.map((launch) => launch.sessionId),
    ['was-working', 'was-done'],
  );
  assert.deepEqual(
    f.daemon.messages.map((m) => [m.sessionId, m.text]),
    [['was-working', CARRY_ON_PROMPT]],
  );
});

test('stopping the office on purpose (Ctrl+C) leaves nothing to carry on', async (t) => {
  const f = carryOnFixture(t);
  const before = manager(f, []);
  // Its terminals run in the host, which ends them without telling the office they exited.
  await before.start();
  await hireInState(f, before, 'desk-1', 'stopped', 'working');
  before.shutdown(false);
  f.daemon.stop();

  const after = manager(f, []);
  t.after(() => after.shutdown());
  await after.start();
  assert.equal(f.daemon.launches.at(-1)?.sessionId, 'stopped');
  assert.equal(f.daemon.messages.length, 1, 'no carry-on after a deliberate stop');
});

test('worktree setup runs before the daemon starts and the first prompt includes setup failures', async (t) => {
  const f = carryOnFixture(t);
  const git = forkRepository(f);
  const command = `printf '%s' "$DROID_OFFICE_ROOT_PATH" > set-up.txt; printf '%s' 'fixture setup failure'; exit 1`;
  writeFileSync(path.join(f.root, '.droid-office.json'), JSON.stringify({ worktree: { setup: command, copy: ['/.env'] } }));
  git('add', '.droid-office.json');
  git('commit', '-qm', 'test setup');
  writeFileSync(path.join(f.root, '.env'), 'LOCAL=fixture');
  const toasts: string[] = [];
  const workers = managed(f, f.root, f.data, f.droid, [], { url: 'http://127.0.0.1:1', token: '' }, { ...events([]), toast: (text) => toasts.push(text) });
  const worker = workers.spawn('desk-1', 'test', 'build the thing', true);
  if (typeof worker === 'string') return assert.fail(worker);
  const cwd = path.join(f.root, worker.worktree!.path);
  assert.match(worker.activity ?? '', /Setting up its worktree/);
  assert.deepEqual(f.daemon.launches, []);
  const launch = await initializedWorker(f, worker.id);
  assert.equal(readFileSync(path.join(cwd, '.env'), 'utf8'), 'LOCAL=fixture');
  assert.equal(realpathSync(readFileSync(path.join(cwd, 'set-up.txt'), 'utf8')), realpathSync(f.root));
  assert.match(toasts.at(-1) ?? '', /worktree setup failed/);
  const message = await waitFor(() => f.daemon.messages.find((m) => m.sessionId === launch.sessionId)?.text, Boolean);
  assert.match(message ?? '', /fixture setup failure[\s\S]+build the thing$/);
});
test('a worktree worker that makes its own branch is followed there: O finds the PR it opened, and sending it home tidies both branches', async (t) => {
  const f = carryOnFixture(t);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  git(f.root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(f.root, 'a.txt'), 'a');
  git(f.root, 'add', 'a.txt');
  git(f.root, 'commit', '-qm', 'init');
  // GitHub has one open pull request, from the branch the worker is about to make.
  writeFileSync(path.join(path.dirname(f.droid), 'gh'), `#!/bin/sh\ncase "$*" in *"--head fix-x "*) echo '[{"number":242,"url":"https://github.com/o/r/pull/242"}]';; *) echo '[]';; esac\n`, { mode: 0o700 });
  const updates: WorkerInfo[] = [];
  const workers = manager(f, updates);
  t.after(() => workers.shutdown());
  const worker = workers.spawn('desk-1', 'test', 'fix x on a new branch and open a PR', true);
  assert.notEqual(typeof worker, 'string');
  if (typeof worker === 'string') return;
  const office = worker.worktree!.branch;
  assert.match(office, /^office\//);
  const launch = await initializedWorker(f, worker.id);
  await waitFor(() => f.daemon.messages.find((m) => m.sessionId === launch.sessionId), Boolean);
  // What the task told it to do: a branch of its own, a commit, a PR from there.
  const cwd = path.join(f.root, worker.worktree!.path);
  git(cwd, 'checkout', '-qb', 'fix-x');
  writeFileSync(path.join(cwd, 'x.txt'), 'x');
  git(cwd, 'add', 'x.txt');
  git(cwd, 'commit', '-qm', 'fix x');
  f.daemon.notify(worker.sessionId!, { type: 'agent_turn_completed' });
  const info = await waitFor(
    () => workers.get(worker.id)!,
    (w) => w.worktree?.branch === 'fix-x',
  );
  assert.equal(info.worktree!.made, office);
  assert.equal(updates.at(-1)?.worktree?.branch, 'fix-x');
  // Saved, for a restarted office and for `droid-office prune`.
  const saved = JSON.parse(readFileSync(path.join(f.data, 'workers.json'), 'utf8')) as WorkerInfo[];
  assert.deepEqual(saved.find((w) => w.id === worker.id)?.worktree, info.worktree);
  // O at the desk: the PR it opened, not "has no commits on office/… yet".
  const pr = await workers.openPr(worker.id, 'Cody');
  assert.deepEqual(pr, { prs: [{ number: 242, url: 'https://github.com/o/r/pull/242', existed: true, dirty: false }], failed: [] });
  assert.deepEqual(workers.get(worker.id)?.pr, { number: 242, url: 'https://github.com/o/r/pull/242' });
  // Sent home: the worktree goes, with its branch and the office's (which holds nothing fix-x lacks).
  const home = await workers.kill(worker.id, 'all');
  assert.equal(home.error, undefined);
  assert.equal(home.note, `Deleted ${worker.name}'s worktree and branch fix-x`);
  assert.equal(git(f.root, 'branch', '--list', 'fix-x', office), '');
  assert.ok(!existsSync(cwd));
  // One that checked out a branch from before it was hired leaves that branch be.
  execFileSync('git', ['branch', 'release'], { cwd: f.root, env: { ...process.env, GIT_COMMITTER_DATE: '@1000000000 +0000' } });
  const other = workers.spawn('desk-2', 'test', 'look at the release branch', true);
  assert.notEqual(typeof other, 'string');
  if (typeof other === 'string') return;
  git(path.join(f.root, other.worktree!.path), 'checkout', '-q', 'release');
  const left = await workers.kill(other.id, 'all');
  assert.equal(left.note, `Deleted ${other.name}'s worktree and branch ${other.worktree!.branch}`);
  assert.equal(git(f.root, 'branch', '--list', '--format=%(refname:short)', 'release', other.worktree!.branch), 'release');
  const lead = workers.spawn('desk-1', 'test');
  if (typeof lead === 'string') throw new Error(lead);
  assert.match((await workers.dismissTeam(lead.id, true, false)).error!, /main checkout/);
  const named = workers.spawn('desk-2', 'test', 'inspect', true, 'agent', undefined, undefined, [], lead.id, undefined, 'main', 'feat/structured-task');
  if (typeof named === 'string') throw new Error(named);
  assert.equal(named.worktree!.branch, 'feat/structured-task');
  assert.match((await workers.dismissTeam(named.id, true, true)).error!, /finish/);
  const namedLaunch = await initializedWorker(f, named.id);
  await waitFor(() => f.daemon.messages.some((m) => m.sessionId === namedLaunch.sessionId), Boolean);
  f.daemon.notify(namedLaunch.sessionId, { type: 'agent_turn_completed' });
  const namedCwd = path.join(f.root, named.worktree!.path);
  writeFileSync(path.join(namedCwd, 'a.txt'), 'uncommitted');
  assert.match((await workers.dismissTeam(named.id, true, true)).error!, /dirty/);
  assert.ok(workers.get(named.id), 'dirty preflight does not dismiss');
  writeFileSync(path.join(namedCwd, 'a.txt'), 'a');
  const removed = await workers.dismissTeam(named.id, true, true);
  assert.equal(removed.error, undefined);
  assert.equal(existsSync(namedCwd), false);
  assert.ok(git(f.root, 'branch', '--list', 'feat/structured-task'), 'keeps branch by default');
  const kept = workers.spawn('desk-2', 'test', 'read', true);
  if (typeof kept === 'string') throw new Error(kept);
  assert.equal((await workers.dismissTeam(kept.id, false, true)).error, undefined);
  assert.equal(existsSync(path.join(f.root, kept.worktree!.path)), true);
  assert.equal(workers.get(kept.id), undefined);
  assert.equal((await workers.dismissTeam('unknown-worker', false, true)).error, 'Worker is no longer on this floor');
});

test("the office's branch keeps a worker's commits once it has moved on: the dialog warns, and sending it home never deletes them", async (t) => {
  const f = carryOnFixture(t);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  git(f.root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(f.root, 'a.txt'), 'a');
  git(f.root, 'add', 'a.txt');
  git(f.root, 'commit', '-qm', 'init');
  execFileSync('git', ['branch', 'release'], { cwd: f.root, env: { ...process.env, GIT_COMMITTER_DATE: '@1000000000 +0000' } });
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  /** A worker that commits on the office's branch, then goes to another one. */
  const hire = (desk: string, ...checkout: string[]) => {
    const w = workers.spawn(desk, 'test', 'commit, then switch branches', true);
    if (typeof w === 'string') throw new Error(w);
    const cwd = path.join(f.root, w.worktree!.path);
    writeFileSync(path.join(cwd, `${desk}.txt`), desk);
    git(cwd, 'add', `${desk}.txt`);
    git(cwd, 'commit', '-qm', `work at ${desk}`);
    git(cwd, 'checkout', '-q', ...checkout);
    return { w, cwd, office: w.worktree!.branch };
  };
  const tip = (branch: string) => git(f.root, 'log', '-1', '--format=%s', branch);
  // Onto release, which was there before it: the commit is only on the office's branch.
  const a = hire('desk-1', 'release');
  assert.deepEqual(await workers.inspectWorktree(a.w.id), { exists: true, dirty: 0, ahead: 1, unpushed: 1 });
  assert.equal(workers.get(a.w.id)?.worktree?.made, a.office);
  // Deleting the worktree and branch anyway: release isn't the office's, and the office's has the commit.
  const sent = await workers.kill(a.w.id, 'all');
  assert.equal(sent.error, undefined);
  assert.equal(sent.note, `Deleted ${a.w.name}'s worktree and kept branch ${a.office} — it has 1 unpushed commit`);
  assert.ok(!existsSync(a.cwd));
  assert.equal(tip(a.office), 'work at desk-1');
  assert.equal(tip('release'), 'init');
  // Sent home with no choice (leave-on-merge): nothing goes.
  const b = hire('desk-2', 'release');
  assert.equal((await workers.kill(b.w.id)).note, `Kept ${b.w.name}'s worktree and branch release — it has 1 unpushed commit`);
  assert.ok(existsSync(b.cwd));
  assert.equal(tip(b.office), 'work at desk-2');
  // A branch of its own, cut from main without that commit: it goes, the office's stays.
  const c = hire('desk-3', '-b', 'fix-z', 'main');
  const own = await workers.kill(c.w.id, 'all');
  assert.equal(own.note, `Deleted ${c.w.name}'s worktree and branch fix-z, and kept branch ${c.office} — it has 1 unpushed commit`);
  assert.equal(git(f.root, 'branch', '--list', 'fix-z'), '');
  assert.equal(tip(c.office), 'work at desk-3');
});

test('commits on a detached HEAD count as work: sending the worker home keeps them unless asked to delete', async (t) => {
  const f = carryOnFixture(t);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  /** A commit of `file` on HEAD, written as a fixture object so no Git identity is needed. */
  const commit = (cwd: string, file: string) => {
    writeFileSync(path.join(cwd, file), file);
    git(cwd, 'add', file);
    let parent = '';
    try {
      parent = git(cwd, 'rev-parse', '--verify', '--quiet', 'HEAD');
    } catch {
      // the repository's first commit
    }
    const object = [
      `tree ${git(cwd, 'write-tree')}`,
      ...(parent ? [`parent ${parent}`] : []),
      'author Fixture <fixture@example.invalid> 1000000000 +0000',
      'committer Fixture <fixture@example.invalid> 1000000000 +0000',
      '',
      `add ${file}`,
      '',
    ].join('\n');
    const oid = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd, input: object, encoding: 'utf8' }).trim();
    git(cwd, 'update-ref', 'HEAD', oid);
    return oid;
  };
  git(f.root, 'init', '-q', '-b', 'main');
  commit(f.root, 'a.txt');
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  const hire = (desk: string) => {
    const w = workers.spawn(desk, 'test', 'work on a detached HEAD', true);
    if (typeof w === 'string') throw new Error(w);
    const cwd = path.join(f.root, w.worktree!.path);
    git(cwd, 'checkout', '-q', '--detach');
    return { w, cwd, office: w.worktree!.branch };
  };
  // A commit only the detached HEAD has: the dialog warns, and sending it home with no choice keeps it all.
  const a = hire('desk-1');
  const sha = commit(a.cwd, 'detached.txt');
  assert.deepEqual(await workers.inspectWorktree(a.w.id), { exists: true, dirty: 0, ahead: 1, unpushed: 1 });
  assert.equal((await workers.kill(a.w.id)).note, `Kept ${a.w.name}'s worktree and branch ${a.office} — it has 1 unpushed commit`);
  assert.ok(existsSync(a.cwd));
  assert.equal(git(a.cwd, 'rev-parse', 'HEAD'), sha);
  // Detached with nothing of its own: it all goes, as for a worker on its branch.
  const b = hire('desk-2');
  assert.deepEqual(await workers.inspectWorktree(b.w.id), { exists: true, dirty: 0, ahead: 0, unpushed: 0 });
  assert.equal((await workers.kill(b.w.id)).note, `Deleted ${b.w.name}'s worktree and branch ${b.office}`);
  assert.ok(!existsSync(b.cwd));
  // Asked to delete everything, after that warning: it does.
  const c = hire('desk-3');
  commit(c.cwd, 'asked.txt');
  assert.equal((await workers.inspectWorktree(c.w.id))?.unpushed, 1);
  assert.equal((await workers.kill(c.w.id, 'all')).note, `Deleted ${c.w.name}'s worktree and branch ${c.office}`);
  assert.ok(!existsSync(c.cwd));
});

test("a worker that renames the office's branch goes home with it; one that deletes it leaves the branch it's on", async (t) => {
  const f = carryOnFixture(t);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  git(f.root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(f.root, 'a.txt'), 'a');
  git(f.root, 'add', 'a.txt');
  git(f.root, 'commit', '-qm', 'init');
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  const hire = (desk: string) => {
    const w = workers.spawn(desk, 'test', 'fix x and name the branch after it', true);
    if (typeof w === 'string') throw new Error(w);
    return { w, cwd: path.join(f.root, w.worktree!.path), office: w.worktree!.branch };
  };
  const a = hire('desk-1');
  await waitFor(() => a.w.sessionId, Boolean);
  writeFileSync(path.join(a.cwd, 'x.txt'), 'x');
  git(a.cwd, 'add', 'x.txt');
  git(a.cwd, 'commit', '-qm', 'fix x');
  git(a.cwd, 'branch', '-m', 'fix-x');
  f.daemon.notify(a.w.sessionId!, { type: 'agent_turn_completed' });
  // Followed there, with nothing to remember: office/… is gone, fix-x is it.
  const info = await waitFor(
    () => workers.get(a.w.id)!,
    (w) => w.worktree?.branch === 'fix-x',
  );
  assert.equal(info.worktree!.made, undefined);
  const sent = await workers.kill(a.w.id, 'all');
  assert.equal(sent.error, undefined);
  assert.equal(sent.note, `Deleted ${a.w.name}'s worktree and branch fix-x`);
  assert.equal(git(f.root, 'branch', '--list', 'fix-x', a.office), '');
  assert.ok(!existsSync(a.cwd));
  // Renamed with nothing unpushed (its PR merged, say) and sent home before it came to rest: all of it goes.
  const b = hire('desk-2');
  git(b.cwd, 'branch', '-m', 'fix-y');
  assert.deepEqual(await workers.kill(b.w.id), { note: `Deleted ${b.w.name}'s worktree and branch fix-y` });
  assert.equal(git(f.root, 'branch', '--list', 'fix-y', b.office), '');
  // The office's branch deleted instead: git can't say whether the one it's on is its own, so it stays.
  const c = hire('desk-3');
  git(c.cwd, 'checkout', '-qb', 'fix-w');
  git(c.cwd, 'branch', '-D', c.office);
  assert.deepEqual(await workers.kill(c.w.id, 'all'), { note: `Deleted ${c.w.name}'s worktree and kept branch fix-w` });
  assert.equal(git(f.root, 'branch', '--list', '--format=%(refname:short)', 'fix-w', c.office), 'fix-w');
  assert.ok(!existsSync(c.cwd));
});

test("only a branch the worker made is its own to delete, and the office's stays when it has commits that one doesn't", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-made-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'a.txt'), 'a');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');
  // A branch that was there long before any worker (its reflog says it was made in 2001).
  execFileSync('git', ['branch', 'release'], { cwd: dir, env: { ...process.env, GIT_COMMITTER_DATE: '@1000000000 +0000' } });
  const trees = new Worktrees(dir);
  const made = trees.create('mochi-1234');
  assert.notEqual(typeof made, 'string');
  if (typeof made === 'string') return;
  const cwd = path.join(dir, made.path);
  const gitIn = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  // A commit on the office's branch, then a fresh branch from main that doesn't have it.
  writeFileSync(path.join(cwd, 'o.txt'), 'o');
  gitIn('add', 'o.txt');
  gitIn('commit', '-qm', 'on the office branch');
  gitIn('checkout', '-qb', 'fix-y', 'main');
  assert.equal(await trees.branchOf(made), 'fix-y');
  assert.equal(await trees.madeSince('fix-y', made.branch), true);
  assert.equal(await trees.madeSince('release', made.branch), false);
  assert.equal(await trees.madeSince('main', made.branch), false);
  assert.equal((await trees.sendHome({ ...made, branch: 'fix-y', made: made.branch }, 'all')).error, undefined);
  assert.equal(git('branch', '--list', 'fix-y'), '');
  assert.equal(git('branch', '--list', made.branch).replace(/^\*?\s+/, ''), made.branch);
});

test('a worker whose worktree was deleted outside the office waits, marked lost, instead of failing to start; rebuilding puts it back and it carries on', async (t) => {
  const f = carryOnFixture(t);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  git(f.root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(f.root, 'a.txt'), 'a');
  git(f.root, 'add', 'a.txt');
  git(f.root, 'commit', '-qm', 'init');
  const officeWith = (updates: WorkerInfo[], toasts: string[]) => managed(f, f.root, f.data, f.droid, ['--from-test'], { url: 'http://127.0.0.1:1', token: '' }, { ...events(updates), toast: (text) => toasts.push(text) });
  const before = officeWith([], []);
  const hire = async (deskId: string, session: string) => {
    f.daemon.nextSessionId = session;
    const worker = before.spawn(deskId, 'test', `task for ${session}`, true);
    if (typeof worker === 'string') throw new Error(worker);
    await waitFor(() => worker.sessionId, Boolean);
    return worker;
  };
  const kept = await hire('desk-1', 'kept-branch');
  const gone = await hire('desk-2', 'gone-branch');
  // Kept did some work on its branch; gone's branch goes with its folder.
  const keptDir = path.join(f.root, kept.worktree!.path);
  writeFileSync(path.join(keptDir, 'work.txt'), 'work');
  git(keptDir, 'add', 'work.txt');
  git(keptDir, 'commit', '-qm', 'work');
  before.shutdown(true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Deleted while the office was down, by hand.
  rmSync(keptDir, { recursive: true, force: true });
  rmSync(path.join(f.root, gone.worktree!.path), { recursive: true, force: true });
  git(f.root, 'worktree', 'prune');
  git(f.root, 'branch', '-D', gone.worktree!.branch);

  const updates: WorkerInfo[] = [];
  const toasts: string[] = [];
  const after = officeWith(updates, toasts);
  t.after(() => after.shutdown());
  const launched = f.daemon.launches.length;
  await after.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Nobody started, nobody was told "could not start": both wait at their desks, marked lost.
  assert.equal(f.daemon.launches.length, launched);
  assert.deepEqual(toasts, []);
  assert.deepEqual(after.get(kept.id)?.lost, { branch: 'here' });
  assert.deepEqual(after.get(gone.id)?.lost, { branch: 'gone' });
  assert.equal(after.get(kept.id)?.status, 'offline');
  assert.match(after.resume(kept.id) ?? '', /worktree .* was deleted outside droid-office/);
  assert.equal(f.daemon.launches.length, launched);

  // Put back on its own branch, work and all, and it carries on its conversation.
  assert.deepEqual(await after.rebuild(kept.id), { rebuilt: true, note: undefined });
  assert.equal(git(keptDir, 'rev-parse', '--abbrev-ref', 'HEAD'), kept.worktree!.branch);
  assert.ok(existsSync(path.join(keptDir, 'work.txt')));
  assert.equal(after.get(kept.id)?.lost, undefined);
  const resumed = await waitFor(
    () => f.daemon.launches.slice(launched),
    (x) => x.length > 0,
  );
  assert.equal(resumed[0].sessionId, 'kept-branch');

  // Its branch gone too: made again from where it started.
  const again = await after.rebuild(gone.id);
  assert.equal(again.rebuilt, true);
  assert.match(again.note ?? '', /was deleted too/);
  assert.equal(git(path.join(f.root, gone.worktree!.path), 'rev-parse', 'HEAD'), gone.worktree!.base);
  assert.equal(after.get(gone.id)?.lost, undefined);
  assert.deepEqual(toasts, []);
});

test('two connections share one terminal: closing one leaves the other subscribed, open and streaming', async (t) => {
  const f = carryOnFixture(t);
  const updates: WorkerInfo[] = [];
  const streamed: { workerId: string; data: string; to: string[] }[] = [];
  const workers = managed(f, f.root, f.data, f.droid, ['--from-test'], { url: 'http://127.0.0.1:1', token: '' }, { ...events(updates), data: (workerId, data, to) => streamed.push({ workerId, data, to }) });
  t.after(() => workers.shutdown());
  const savedShell = process.env.SHELL;
  process.env.SHELL = f.droid;
  t.after(() => {
    if (savedShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = savedShell;
  });
  const spawned = workers.spawn('desk-1', 'test', undefined, false, 'shell');
  assert.notEqual(typeof spawned, 'string');
  if (typeof spawned === 'string') throw new Error(spawned);
  const id = spawned.id;
  assert.equal(workers.get(id)?.open, false);

  const a = workers.attach(id, 'conn-a');
  assert.ok(a);
  assert.equal(workers.get(id)?.open, true);
  assert.ok(workers.attach(id, 'conn-b'));
  // The fake agent announces itself; both connections stream it.
  const first = await waitFor(
    () => streamed,
    (x) => x.some((s) => s.data.includes('fake-agent-ready')),
  );
  assert.deepEqual(first.find((s) => s.data.includes('fake-agent-ready'))?.to, ['conn-a', 'conn-b']);

  // One window closes: the other keeps the terminal open and streaming.
  workers.detach(id, 'conn-a');
  assert.equal(workers.get(id)?.open, true);
  workers.write(id, 'echo still-here\r');
  const second = await waitFor(
    () => streamed,
    (x) => x.some((s) => s.data.includes('still-here')),
  );
  assert.deepEqual(
    second.filter((s) => s.data.includes('still-here')).map((s) => s.to),
    [['conn-b']],
  );
  // The echo is the PTY's; the agent logs the keystrokes on its own time, before teardown takes its log away.
  await waitFor(
    () =>
      f
        .read()
        .map((inv) => inv.stdin ?? '')
        .join(''),
    (x) => x.includes('still-here'),
  );

  // The last one out closes it; detaching a stranger changes nothing.
  workers.detach(id, 'conn-b');
  assert.equal(workers.get(id)?.open, false);
  const n = updates.length;
  workers.detach(id, 'conn-a');
  assert.equal(updates.length, n);

  // Gone for good: no subscriber entry is left behind.
  workers.attach(id, 'conn-a');
  await workers.kill(id);
  assert.equal((workers as unknown as { subscribers: Map<string, Set<string>> }).subscribers.has(id), false);
  assert.equal(workers.attach(id, 'conn-a'), undefined);
});

test('a worker restored from before subscriptions keeps its names, maps its last input time, and starts unopened', async (t) => {
  const f = carryOnFixture(t);
  writeFileSync(
    path.join(f.data, 'workers.json'),
    JSON.stringify([
      {
        id: 'legacy-1',
        kind: 'agent',
        deskId: 'desk-1',
        name: 'Legacy',
        color: '#fff',
        createdBy: 'Old Teammate',
        createdAt: 1000,
        viewers: ['Old Teammate'],
        viewerIds: ['ghost-connection'],
        lastInput: { by: 'Old Teammate', at: 4242 },
      },
      {
        id: 'legacy-2',
        kind: 'agent',
        deskId: 'desk-2',
        name: 'Legacy Two',
        color: '#fff',
        createdBy: 'Old Teammate',
        createdAt: 1000,
        lastInput: { by: 'Old Teammate' },
      },
    ]),
  );
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  const info = workers.get('legacy-1');
  assert.ok(info);
  assert.equal(info.createdBy, 'Old Teammate');
  assert.equal(info.lastInputAt, 4242);
  assert.equal(info.open, false);
  assert.equal(workers.get('legacy-2')?.lastInputAt, undefined);
  // Subscriptions start empty: no ghost streams, and detaching the ghost changes nothing.
  assert.deepEqual([...(workers as unknown as { subscribers: Map<string, Set<string>> }).subscribers.keys()], []);
  workers.detachAll('ghost-connection');
  assert.equal(workers.get('legacy-1')?.open, false);
  // Still visible and actionable: it opens, closes, and gets back to work.
  assert.ok(workers.open('legacy-1', 'conn-a'));
  assert.equal(workers.get('legacy-1')?.open, true);
  workers.detachAll('conn-a');
  assert.equal(workers.get('legacy-1')?.open, false);
  assert.equal(workers.resume('legacy-1'), undefined);
  await waitFor(() => info.sessionId, Boolean);
});

test('a subagent sits down told who hired it and where it works; its lead goes on record with no office command on disk', async (t) => {
  const f = carryOnFixture(t);
  const bin = path.join(f.data, 'bin', 'team');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'office-workers'), '#!/bin/sh\n');
  const workers = manager(f, [], []);
  t.after(() => workers.shutdown());

  assert.equal(existsSync(bin), false, 'the commands from before the Office MCP are deleted');

  const lead = workers.spawn('desk-1', 'Ada', 'Ship the login fix');
  assert.ok(typeof lead === 'object');
  if (typeof lead !== 'object') return;
  assert.equal(lead.lead, undefined);
  assert.match(workers.spawn('desk-3', lead.name, 'x', false, 'agent', undefined, undefined, [], 'nobody') as string, /lead has left/);
  assert.match(workers.spawn('desk-3', lead.name, 'x', false, 'shell', undefined, undefined, [], lead.id) as string, /an agent at a desk/);
  assert.match(workers.spawn('station-lead', lead.name, 'x', false, 'agent', undefined, undefined, [], lead.id) as string, /Unknown desk/);

  const context = '## Siblings at hire time\nByte: working, branch office/api.\nCurrent context: team_board.';
  workers.subagentContext = () => context;
  const sub = workers.spawn('desk-3', lead.name, 'Fix the redirect', false, 'agent', undefined, undefined, [], lead.id);
  assert.ok(typeof sub === 'object');
  if (typeof sub !== 'object') return;
  assert.equal(sub.lead, lead.id);
  assert.equal(sub.prompt, 'Fix the redirect', 'its card shows the task alone');
  assert.match(workers.spawn('desk-4', sub.name, 'x', false, 'agent', undefined, undefined, [], sub.id) as string, /can't hire subagents of its own/);

  await waitFor(
    () => f.daemon.messages.length,
    (n) => n === 2,
  );
  const leadMsg = f.daemon.messages.find((m) => m.sessionId === lead.sessionId);
  const subMsg = f.daemon.messages.find((m) => m.sessionId === sub.sessionId)!;
  assert.equal(leadMsg?.text, 'Ship the login fix', 'a worker nobody hired is told nothing extra');
  const brief = subMsg.text;
  assert.match(brief, new RegExp(`^Droid Office role: ${sub.name}, subagent of ${lead.name} \\(a worker, not the owner\\)`));
  assert.match(brief, /Your session starts in the project's main checkout/);
  assert.doesNotMatch(brief, /You work in/);
  assert.match(brief, /`team_report`/);
  assert.ok(brief.endsWith(`## Task from ${lead.name}\n\`\`\`text\nFix the redirect\n\`\`\`\n\n${context}`));
  assert.equal(workers.get(sub.id)?.prompt, 'Fix the redirect');
  f.daemon.notify(subMsg.sessionId, { type: 'create_message', message: { id: 'sub-user', role: 'user', content: [{ type: 'text', text: brief }] } });
  await waitFor(
    () => workers.tail(sub.id, 20),
    (s) => !!s?.includes('Fix the redirect'),
  );
  assert.equal(workers.tail('nobody', 20), undefined);
  // Its lead's title goes on its card.
  workers.setTask(sub.id, { name: `  ${'Fix login '.repeat(10)}`, summary: 'Fix the redirect' });
  assert.equal(workers.get(sub.id)?.task?.name.length, 60);

  // The lead survives a restart; a subagent of a lead that's gone has none.
  workers.shutdown(true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const saved = JSON.parse(readFileSync(path.join(f.data, 'workers.json'), 'utf8')) as WorkerInfo[];
  assert.equal(saved.find((w) => w.id === sub.id)?.lead, lead.id);
  writeFileSync(path.join(f.data, 'workers.json'), JSON.stringify([...saved, { ...saved.find((w) => w.id === sub.id), id: 'orphan', deskId: 'desk-6', name: 'Orphan', lead: 'gone' }]));
  const after = manager(f, [], []);
  t.after(() => after.shutdown());
  assert.equal(after.get(sub.id)?.lead, lead.id);
  assert.equal(after.get('orphan')?.lead, undefined);
  assert.equal(after.get(sub.id)?.task?.name.length, 60);

  // Sending the lead home leaves its subagents at their desks, on their own.
  await after.kill(lead.id);
  assert.equal(after.get(sub.id)?.lead, undefined);
});

test('custom subagent briefs keep the lead task exactly once, with or without a text placeholder', async (t) => {
  const f = carryOnFixture(t);
  let custom = 'Office instructions for {{name}}. Task from {{lead}}:';
  const source: PromptSource = { text: (id) => (id === 'subagent.brief' ? custom : PROMPTS[id].text), agent: () => undefined };
  const workers = managed(f, f.root, f.data, f.droid, [], { url: 'http://127.0.0.1:1', token: '' }, events([]), undefined, undefined, source);
  t.after(() => workers.shutdown());
  const lead = workers.spawn('desk-1', 'test', 'Lead task');
  if (typeof lead === 'string') return assert.fail(lead);
  for (const [desk, template] of [
    ['desk-2', custom],
    ['desk-3', 'Task from {{lead}}:\n{{ text }}\nOffice instructions: report back.'],
  ]) {
    custom = template;
    const sub = workers.spawn(desk, lead.name, 'Use {{lead}} literally', false, 'agent', undefined, undefined, [], lead.id);
    if (typeof sub === 'string') return assert.fail(sub);
    const text = await waitFor(() => f.daemon.messages.find((m) => m.sessionId === sub.sessionId)?.text, Boolean);
    assert.equal(text?.split('Use {{lead}} literally').length, 2, 'task is included once without expanding its placeholders');
    assert.equal(text, desk === 'desk-2' ? `Office instructions for ${sub.name}. Task from ${lead.name}:\n\nUse {{lead}} literally` : `Task from ${lead.name}:\nUse {{lead}} literally\nOffice instructions: report back.`);
  }
});

test('team markings form with the first hire, survive restarts and the lead leaving, and never restore a lead', async (t) => {
  const f = carryOnFixture(t);
  const workers = manager(f, [], []);
  t.after(() => workers.shutdown());
  const hire = (desk: string, lead?: string) => {
    const w = workers.spawn(desk, 'Ada', 'work', false, 'agent', undefined, undefined, [], lead);
    assert.ok(typeof w === 'object', String(w));
    return w as WorkerInfo;
  };
  const ada = hire('desk-1');
  const bo = hire('desk-5');
  assert.equal(ada.team, undefined, 'a worker who never hired wears nothing');

  const one = hire('desk-2', ada.id);
  const lead = workers.get(ada.id)!.team!;
  assert.deepEqual({ id: lead.id, role: lead.role, leadName: lead.leadName }, { id: ada.id, role: 'lead', leadName: ada.name });
  assert.deepEqual(one.team, { ...lead, role: 'member' });
  const two = hire('desk-3', ada.id);
  assert.deepEqual(two.team, one.team, 'a later subagent joins the same team');
  assert.equal(workers.get(ada.id)!.team, lead, "the lead's markings don't change as the team grows");

  const other = hire('desk-6', bo.id);
  const boTeam = workers.get(bo.id)!.team!;
  assert.notEqual(boTeam.accent, lead.accent);
  assert.notEqual(boTeam.emblem, lead.emblem);
  assert.equal(other.team?.id, bo.id);

  // A restart puts every badge back as it was.
  workers.shutdown(true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const saved = JSON.parse(readFileSync(path.join(f.data, 'workers.json'), 'utf8')) as WorkerInfo[];
  assert.deepEqual(saved.find((w) => w.id === one.id)?.team, one.team);
  const after = manager(f, [], []);
  t.after(() => after.shutdown());
  for (const w of [ada, one, two, bo, other]) assert.deepEqual(after.get(w.id)?.team, (w.id === ada.id ? lead : w.id === bo.id ? boTeam : workers.get(w.id)?.team) ?? w.team);

  // Its lead goes home: the subagents keep whose team they were on, but report to nobody.
  await after.kill(ada.id);
  assert.equal(after.get(one.id)?.lead, undefined);
  assert.deepEqual(after.get(one.id)?.team, one.team);
  // One of them hires for itself: it leads a team of its own, in a look nobody on the floor wears.
  const mine = after.spawn('desk-4', 'x', 'piece', false, 'agent', undefined, undefined, [], one.id) as WorkerInfo;
  const own = after.get(one.id)!.team!;
  assert.equal(own.role, 'lead');
  assert.equal(own.id, one.id);
  assert.notEqual(`${own.accent}|${own.emblem}`, `${lead.accent}|${lead.emblem}`, 'its old team is still worn by its old teammate');
  assert.notEqual(`${own.accent}|${own.emblem}`, `${boTeam.accent}|${boTeam.emblem}`);
  assert.deepEqual(mine.team, { ...own, role: 'member' });
  assert.deepEqual(after.get(two.id)?.team, one.team, 'the teammate left behind keeps the old markings');
  const currentState = readFileSync(path.join(f.data, 'workers.json'), 'utf8');
  workers.shutdown(true);
  assert.equal(readFileSync(path.join(f.data, 'workers.json'), 'utf8'), currentState, 'shutting down the old manager again cannot replace its successor’s state');

  // An office from before markings: its teams get them on the way in, and nobody gains a lead.
  after.shutdown(true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const old = (JSON.parse(readFileSync(path.join(f.data, 'workers.json'), 'utf8')) as WorkerInfo[]).map(({ team: _, ...w }) => w);
  assert.equal(
    old.some((w) => w.id === ada.id),
    false,
    'the departed lead stays removed on disk',
  );
  assert.equal(old.find((w) => w.id === one.id)?.lead, undefined, 'the new lead no longer reports to the departed lead');
  assert.equal(old.find((w) => w.id === mine.id)?.lead, one.id, 'the new team survives shutdown');
  writeFileSync(path.join(f.data, 'workers.json'), JSON.stringify(old));
  const migrated = manager(f, [], []);
  t.after(() => migrated.shutdown());
  assert.equal(migrated.get(one.id)?.team?.role, 'lead');
  assert.deepEqual(migrated.get(mine.id)?.team, { ...migrated.get(one.id)!.team!, role: 'member' });
  assert.equal(migrated.get(bo.id)?.team?.role, 'lead');
  assert.equal(migrated.get(two.id)?.team, undefined, 'no history is invented for a subagent whose lead had already gone');
  assert.equal(migrated.get(two.id)?.lead, undefined);
});
/** Everything the agent has read from its terminal so far: a pty hands it over a line at a time. */
const PICTURE = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);

test('staged pictures reach the daemon with the first and later prompts and are removed with the worker', async (t) => {
  const f = carryOnFixture(t);
  const workers = manager(f, []);
  assert.equal(workers.stageImage('notes.png', Buffer.from('not a picture')), undefined);
  const [a, b] = [workers.stageImage('first.png', PICTURE)!, workers.stageImage('second.png', PICTURE)!];
  assert.ok(a && b);
  const hired = workers.spawn('desk-2', 'test', 'What is wrong here?', false, 'agent', undefined, undefined, [], undefined, [a, b]);
  if (typeof hired === 'string') return assert.fail(hired);
  assert.equal(hired.prompt, 'What is wrong here?');
  const picture = { type: 'base64', data: PICTURE.toString('base64'), mediaType: 'image/png' };
  await waitFor(
    () => f.daemon.messages.length,
    (n) => n === 1,
  );
  assert.deepEqual(f.daemon.messages[0].images, [picture, picture]);
  assert.equal(f.daemon.messages[0].text, hired.prompt);

  const c = workers.stageImage('third.png', PICTURE)!;
  assert.equal(workers.prompt(hired.id, 'And this one?', [c]), undefined);
  assert.deepEqual(f.daemon.messages[1].images, [picture]);
  assert.equal(f.daemon.messages[1].text, 'And this one?');
  const d = workers.stageImage('fourth.png', PICTURE)!;
  assert.equal(workers.prompt(hired.id, '', [d]), undefined);
  assert.equal(workers.get(hired.id)?.activity, 'See the attached images');
  assert.deepEqual(f.daemon.messages[2].images, [picture]);
  assert.equal(f.daemon.messages[2].text, '');
  assert.equal(workers.prompt(hired.id, '  ', []), 'Empty prompt');
  workers.unstage([a, b, c, d]);
  const drops = path.join(f.data, 'drops', hired.id);
  assert.ok(existsSync(drops));
  await workers.kill(hired.id);
  assert.ok(!existsSync(drops));
});

test('a picture-only first message sends no placeholder text to the daemon', async (t) => {
  const f = carryOnFixture(t);
  const workers = manager(f, []);
  const image = workers.stageImage('shot.png', PICTURE)!;
  const worker = workers.spawn('desk-1', 'test', '', false, 'agent', undefined, undefined, [], undefined, [image]);
  if (typeof worker === 'string') return assert.fail(worker);
  assert.equal(worker.prompt, 'See the attached images');
  await waitFor(
    () => f.daemon.messages.length,
    (n) => n === 1,
  );
  assert.equal(f.daemon.messages[0].text, '');
  assert.equal(f.daemon.messages[0].images?.length, 1);
});
test('fresh workers start from the latest main, the checkout moved only when nobody is in its way; subagents start where their lead is', async (t) => {
  const f = carryOnFixture(t);
  const forge = mkdtempSync(path.join(tmpdir(), 'office-fresh-forge-'));
  t.after(() => rmSync(forge, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const origin = path.join(forge, 'origin.git');
  git(forge, 'init', '-q', '--bare', '-b', 'main', origin);
  git(f.root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(f.root, 'a.txt'), 'a');
  git(f.root, 'add', 'a.txt');
  git(f.root, 'commit', '-qm', 'init');
  git(f.root, 'remote', 'add', 'origin', origin);
  git(f.root, 'push', '-q', '-u', 'origin', 'main');
  const github = path.join(forge, 'github');
  git(forge, 'clone', '-q', origin, github);
  const merge = (file: string) => {
    git(github, 'pull', '-q', '--ff-only');
    writeFileSync(path.join(github, file), file);
    git(github, 'add', '.');
    git(github, 'commit', '-qm', file);
    git(github, 'push', '-q', 'origin', 'main');
    return git(github, 'rev-parse', 'HEAD');
  };
  git(f.root, 'checkout', '-q', '-b', 'feature');
  const merged = merge('fix.txt');
  const toasts: string[] = [];
  const moved: string[] = [];
  const workers = managed(f, f.root, f.data, f.droid, ['--from-test'], { url: 'http://127.0.0.1:1', token: '' }, { ...events([]), toast: (text) => toasts.push(text), checkout: (b) => moved.push(b) });
  t.after(() => workers.shutdown());
  // Off (or unset): the checkout's branch, as before, and nothing to fetch for a worker without a worktree.
  assert.equal(workers.fetchBase(true), undefined);
  workers.freshMain = () => true;
  await workers.fetchBase(true);

  // A worktree worker is cut from origin's main while the checkout stays on feature.
  const lead = workers.spawn('desk-1', 'test', 'lead the team', true);
  if (typeof lead === 'string') throw new Error(lead);
  assert.equal(lead.worktree?.base, merged);
  assert.equal(lead.worktree?.from, 'main');
  assert.equal(git(f.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature');

  // One without a worktree: the clean checkout goes over to the latest main for it.
  const direct = workers.spawn('desk-2', 'test', 'look around');
  if (typeof direct === 'string') throw new Error(direct);
  assert.equal(git(f.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), merged);
  assert.deepEqual(moved, ['main']);
  assert.ok(toasts.includes(`🌿 Switched the checkout from feature to main for ${direct.name}`), toasts.join('\n'));
  await waitFor(() => direct.sessionId, Boolean);

  // With that worker in the checkout, the next one doesn't move it from under it.
  git(f.root, 'checkout', '-q', 'feature');
  const second = workers.spawn('desk-3', 'test', 'and another');
  if (typeof second === 'string') throw new Error(second);
  assert.equal(git(f.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
  assert.ok(toasts.includes(`🌿 ${second.name} starts on feature as it is, not the latest main: ${direct.name} is working in it`), toasts.join('\n'));

  // The lead's subagent starts from what the lead committed, on the lead's branch, not from main.
  const leadDir = path.join(f.root, lead.worktree!.path);
  writeFileSync(path.join(leadDir, 'plan.txt'), 'plan');
  git(leadDir, 'add', 'plan.txt');
  git(leadDir, 'commit', '-qm', 'plan');
  const leadHead = git(leadDir, 'rev-parse', 'HEAD');
  merge('later.txt');
  await new Worktrees(f.root).fetch('main');
  const sub = workers.spawn('desk-4', 'test', 'a piece of it', true, 'agent', undefined, undefined, [], lead.id);
  if (typeof sub === 'string') throw new Error(sub);
  assert.equal(sub.worktree?.base, leadHead);
  assert.equal(sub.worktree?.from, lead.worktree?.branch);
  // …or from what the lead names.
  const picked = workers.spawn('desk-5', 'test', 'another piece', true, 'agent', undefined, undefined, [], lead.id, undefined, 'feature');
  if (typeof picked === 'string') throw new Error(picked);
  assert.equal(picked.worktree?.base, git(f.root, 'rev-parse', 'feature'));
  assert.equal(picked.worktree?.from, 'feature');
  assert.match(String(workers.spawn('desk-6', 'test', 'x', true, 'agent', undefined, undefined, [], lead.id, undefined, 'nope')), /no branch, tag or commit called nope/);
  assert.match(String(workers.spawn('desk-6', 'test', 'x', false, 'agent', undefined, undefined, [], lead.id, undefined, 'feature')), /Only a subagent in its own worktree/);
  // A subagent without a worktree never moves the checkout either.
  const quiet = workers.spawn('desk-6', 'test', 'read only', false, 'agent', undefined, undefined, [], lead.id);
  if (typeof quiet === 'string') throw new Error(quiet);
  assert.equal(git(f.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
  // An explicit remote branch ignores the office's default setting, and is fetched before cutting.
  workers.freshMain = () => false;
  const remoteHead = merge('remote-only.txt');
  git(github, 'push', '-q', 'origin', 'main:remote-start');
  assert.equal(await workers.fetchStart('missing-lead', 'origin/main'), undefined);
  assert.equal(workers.fetchStart(lead.id, 'HEAD'), undefined);
  await workers.fetchStart(lead.id, 'origin/remote-start');
  const remote = workers.spawn('desk-7', 'test', 'start from the remote', true, 'agent', undefined, undefined, [], lead.id, undefined, 'origin/remote-start');
  if (typeof remote === 'string') throw new Error(remote);
  assert.equal(remote.worktree?.base, remoteHead);
  assert.equal(remote.worktree?.from, 'remote-start');
  assert.equal(git(f.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
  // The explicit floor override wins even with FreshMain off, but cannot move shared workers.
  git(f.root, 'branch', 'release/next', 'origin/main');
  assert.match((await workers.selectBranch('release/next')) ?? '', /working in it/);
  assert.equal(workers.selectedBranch, undefined);
  for (const w of [direct, second, quiet]) await workers.kill(w.id);
  writeFileSync(path.join(f.root, 'a.txt'), 'uncommitted');
  assert.match((await workers.selectBranch('release/next')) ?? '', /uncommitted/);
  assert.equal(workers.selectedBranch, undefined);
  writeFileSync(path.join(f.root, 'a.txt'), 'a');
  const switching = workers.selectBranch('release/next');
  const concurrent = workers.selectBranch('main');
  assert.match(String(workers.spawn('desk-8', 'test', 'wait')), /switch to finish/);
  assert.match((await concurrent) ?? '', /already in progress/);
  assert.equal(await switching, undefined);
  assert.equal(workers.baseBranch, 'release/next');
  assert.equal(git(f.root, 'branch', '--show-current'), 'release/next');
  assert.equal(new Worktrees(f.root).selectedBranch(), 'release/next');
  const onFloor = workers.spawn('desk-8', 'test', 'from the selected branch', true);
  if (typeof onFloor === 'string') return assert.fail(onFloor);
  assert.equal(onFloor.worktree?.from, 'release/next');
  // A merged temporary checkout returns to the floor choice, not main.
  git(f.root, 'switch', '-q', 'feature');
  workers.pullList = () => [{ state: 'MERGED', headRefName: 'feature', headRefOid: git(f.root, 'rev-parse', 'HEAD') }] as GhPull[];
  await workers.settleCheckout();
  assert.equal(git(f.root, 'branch', '--show-current'), 'release/next');
  assert.equal(await workers.selectBranch('missing'), 'Choose an existing local or origin branch');
  assert.equal(await workers.selectBranch('--detach'), 'Choose an existing local or origin branch');
  assert.equal(await workers.selectBranch(null), undefined);
  assert.equal(workers.selectedBranch, undefined);
  assert.equal(git(f.root, 'branch', '--show-current'), 'main');
});

test('the checkout goes back to main once its branch merged, and subagents of a lead on an old main start from the latest', async (t) => {
  const f = carryOnFixture(t);
  const forge = mkdtempSync(path.join(tmpdir(), 'office-settle-forge-'));
  t.after(() => rmSync(forge, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const origin = path.join(forge, 'origin.git');
  git(forge, 'init', '-q', '--bare', '-b', 'main', origin);
  git(f.root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(f.root, 'a.txt'), 'a');
  git(f.root, 'add', 'a.txt');
  git(f.root, 'commit', '-qm', 'init');
  git(f.root, 'remote', 'add', 'origin', origin);
  git(f.root, 'push', '-q', '-u', 'origin', 'main');
  const github = path.join(forge, 'github');
  git(forge, 'clone', '-q', origin, github);
  const merge = (file: string) => {
    git(github, 'pull', '-q', '--ff-only');
    writeFileSync(path.join(github, file), file);
    git(github, 'add', '.');
    git(github, 'commit', '-qm', file);
    git(github, 'push', '-q', 'origin', 'main');
    return git(github, 'rev-parse', 'HEAD');
  };
  const toasts: string[] = [];
  const workers = managed(f, f.root, f.data, f.droid, ['--from-test'], { url: 'http://127.0.0.1:1', token: '' }, { ...events([]), toast: (text) => toasts.push(text) });
  t.after(() => workers.shutdown());
  const branch = () => git(f.root, 'rev-parse', '--abbrev-ref', 'HEAD');

  // A worker's branch, merged on the forge (squashed: its commit isn't in main).
  git(f.root, 'checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(f.root, 'work.txt'), 'work');
  git(f.root, 'add', 'work.txt');
  git(f.root, 'commit', '-qm', 'work');
  const head = git(f.root, 'rev-parse', 'HEAD');
  const merged = merge('squashed.txt');
  const pull = (state: string, oid = head) => ({ number: 7, state, headRefName: 'feature', headRefOid: oid }) as unknown as GhPull;
  let pulls: GhPull[] = [pull('OPEN')];
  workers.pullList = () => pulls;

  // A worker is sitting in the checkout at rest, as the one that merged would be.
  const first = workers.spawn('desk-1', 'test', 'merge it');
  if (typeof first === 'string') throw new Error(first);
  await waitFor(() => first.sessionId, Boolean);
  first.status = 'idle';

  // Nothing happens with the setting off, or while the pull request is still open.
  await workers.settleCheckout();
  workers.freshMain = () => true;
  await workers.settleCheckout();
  assert.equal(branch(), 'feature');
  // Merged, but at a commit the branch has moved past: not everything landed.
  pulls = [pull('MERGED', merged)];
  await workers.settleCheckout();
  assert.equal(branch(), 'feature');
  // Merged at the commit it's on: back to the latest main, though that worker is still there.
  pulls = [pull('MERGED')];
  await workers.settleCheckout();
  assert.equal(branch(), 'main');
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), merged);
  assert.ok(toasts.includes('🌿 Switched the checkout from feature to main: its pull request merged'), toasts.join('\n'));

  // A lead in the checkout on a main nobody pulled hands its subagents the latest, not that.
  workers.freshMain = () => false;
  const next = merge('later.txt');
  assert.notEqual(git(f.root, 'rev-parse', 'HEAD'), next);
  // (The manager fetched main a moment ago, so a fresh instance does the fetching here.)
  await new Worktrees(f.root).fetch('main');
  assert.equal(workers.fetchStart(first.id), undefined);
  const sub = workers.spawn('desk-2', 'test', 'a piece of it', true, 'agent', undefined, undefined, [], first.id);
  if (typeof sub === 'string') throw new Error(sub);
  assert.equal(sub.worktree?.base, next);
  assert.equal(sub.worktree?.from, 'main');
  assert.equal(git(f.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('a log read ignores a trailing partial line', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const done = { kind: 'droid', args: ['--settings'], env: {} };
  const torn = { kind: 'droid', args: [], env: {} };
  const tornLine = JSON.stringify(torn);
  writeFileSync(f.log, `${JSON.stringify(done)}\n${tornLine.slice(0, -1)}`);
  assert.deepEqual(f.read(), [done]);
  writeFileSync(f.log, `${JSON.stringify(done)}\n${tornLine}\n`);
  assert.deepEqual(f.read(), [done, torn]);
});

test('worker notices steer at end of turn and the completion nudge is delivered once', async (t) => {
  const f = carryOnFixture(t);
  const workers = manager(f, []);
  const worker = await hireInState(f, workers, 'desk-1', 'noticed', 'working');
  assert.equal(workers.notice(worker.id, 'Look at card 3'), true);
  assert.equal(f.daemon.messages.length, 2);
  assert.equal(f.daemon.messages.at(-1)?.text, 'Droid Office notice:\nLook at card 3');
  assert.equal(f.daemon.messages.at(-1)?.queuePlacement, 'end_of_turn');
  workers.beforeStop = () => 'Droid Office notice: report to your lead';
  f.daemon.notify(worker.sessionId!, { type: 'agent_turn_completed' });
  assert.equal(f.daemon.messages.at(-1)?.text, 'Droid Office notice: report to your lead');
  assert.equal(worker.status, 'working');
  f.daemon.notify(worker.sessionId!, { type: 'agent_turn_completed' });
  assert.equal(f.daemon.messages.length, 3, 'the notice is not repeated');
  assert.equal(worker.status, 'done');
});

test('after-turn messages keep the worker busy, and removing them allows the turn to finish', async (t) => {
  const f = carryOnFixture(t);
  const workers = manager(f, []);
  const worker = await hireInState(f, workers, 'desk-1', 'queue-session', 'working');
  const sid = worker.sessionId!;
  const turns: string[] = [];
  workers.nextTurn = (info) => turns.push(info.id);

  assert.equal(workers.prompt(worker.id, 'Steer now'), undefined);
  assert.equal(workers.prompt(worker.id, 'Then do this', [], true), undefined);
  const [steer, later] = f.daemon.messages.slice(-2);
  assert.deepEqual([steer.text, steer.queuePlacement, later.text, later.queuePlacement], ['Steer now', 'end_of_turn', 'Then do this', 'end_of_loop']);
  f.daemon.notify(sid, { type: 'agent_turn_completed' });
  assert.equal(worker.status, 'working');
  assert.deepEqual(turns, [worker.id]);
  f.daemon.notify(sid, { type: 'create_message', requestId: later.requestId, message: { id: 'queued-user', role: 'user', content: later.text } });
  f.daemon.notify(sid, { type: 'agent_turn_completed' });
  assert.equal(worker.status, 'done');

  assert.equal(workers.prompt(worker.id, 'Start again'), undefined);
  assert.equal(workers.prompt(worker.id, 'Do not send', [], true), undefined);
  const discarded = f.daemon.messages.at(-1)!;
  f.daemon.notify(sid, { type: 'queued_messages_discarded', requestId: discarded.requestId });
  f.daemon.notify(sid, { type: 'agent_turn_completed' });
  assert.equal(worker.status, 'done');
});

test('switchModel updates the daemon by id and applies a saved choice on resume', async (t) => {
  const f = carryOnFixture(t);
  const workers = manager(f, []);
  const worker = workers.spawn('desk-1', 'owner', undefined, false, 'agent', 'claude-sonnet-5-5');
  if (typeof worker === 'string') return assert.fail(worker);
  const sessionId = await waitFor(() => worker.sessionId, Boolean);
  const failure = t.mock.method(f.daemon, 'updateSessionSettings', async () => {
    throw new Error('Droid refused this setting');
  });
  const model = { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' };
  assert.deepEqual(await workers.switchModel(worker.id, model), { error: 'Droid refused this setting' });
  assert.equal(worker.model, 'claude-sonnet-5-5');
  failure.mock.restore();
  assert.deepEqual(await workers.switchModel(worker.id, model, 'high'), { applied: 'now' });
  assert.deepEqual(f.daemon.settingsChanges[0], { sessionId, modelId: model.id, reasoningEffort: 'high' });
  assert.equal(worker.activeModel, model.id);
  assert.equal(workers.halt(worker.id), true);
  const custom = { id: 'custom:droidproxy:gpt-6.1-sol', name: 'DroidProxy: GPT 6.1 Sol' };
  assert.deepEqual(await workers.switchModel(worker.id, custom), { applied: 'next_launch' });
  assert.equal(f.daemon.settingsChanges.length, 1);
  assert.equal(workers.resume(worker.id), undefined);
  await waitFor(
    () => f.daemon.settingsChanges.length,
    (n) => n === 2,
  );
  assert.equal(f.daemon.settingsChanges[1].modelId, custom.id);
  assert.equal(f.daemon.launches[1].sessionId, sessionId);
  assert.ok('error' in (await workers.switchModel(worker.id, { id: 'bad model\nid', name: 'x' })));
  workers.modelGate = (id) => (id === model.id ? 'GPT-6.1 Sol is out of quota' : undefined);
  assert.deepEqual(await workers.switchModel(worker.id, model), { error: 'GPT-6.1 Sol is out of quota' });
  assert.equal(worker.model, custom.id);
});
