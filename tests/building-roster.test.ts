import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { Store } from '../src/client/state.js';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { TestDaemon } from './daemon-fixture.js';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol.js';

const question = 'Which greeting should I write into HELLO.md?';

function initGitRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFileSync(path.join(dir, 'README.md'), '# Repo\n');
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', 'README.md'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init'], { cwd: dir });
}

function socket(t: { after(fn: () => void): void }, base: string, query: string) {
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?${query}`, { origin: base });
  t.after(() => ws.terminate());
  const messages: ServerMsg[] = [];
  const listeners = new Set<() => void>();
  ws.on('message', (data) => {
    messages.push(JSON.parse(String(data)));
    listeners.forEach((fn) => fn());
  });
  function wait<T extends ServerMsg['t']>(type: T, predicate: (msg: Extract<ServerMsg, { t: T }>) => boolean = () => true): Promise<Extract<ServerMsg, { t: T }>> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = messages.find((m): m is Extract<ServerMsg, { t: T }> => m.t === type && predicate(m as Extract<ServerMsg, { t: T }>));
        if (!found) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve(found);
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(Error(`Timed out waiting for ${type}`));
      }, 8000);
      listeners.add(check);
      check();
    });
  }
  const send = (msg: ClientMsg) => ws.send(JSON.stringify(msg));
  return { ws, messages, wait, send };
}

test('companions receive the full building roster, off-floor AskUser questions, and cross-floor answer/fork/dismiss/thread actions', { skip: process.platform === 'win32' }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'building-roster-'));
  const cleanups: (() => void | Promise<void>)[] = [];
  const rig = { after: (fn: () => void | Promise<void>) => void cleanups.push(fn) };
  t.after(async () => {
    try {
      for (const fn of cleanups.reverse()) await fn();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
  const repoA = path.join(root, 'alpha');
  const repoB = path.join(root, 'beta');
  initGitRepo(repoA);
  initGitRepo(repoB);

  const cfg = loadConfig(['--home', root, '--projects', root, repoA, '--weather', 'clear', '--host', '127.0.0.1', '--agent', '/not-a-real-droid']);
  cfg.port = 0;
  const daemon = new TestDaemon(cfg.dataDir);
  const server = await startServer(cfg, { localDaemon: daemon });
  rig.after(async () => {
    const closing = once(server.server, 'close');
    server.shutdown();
    server.server.closeAllConnections();
    await closing;
  });
  const port = (server.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const pair = (await (await fetch(`${base}/api/mobile/pair`, { method: 'POST', body: '{"device":"Pixel"}' })).json()) as { token: string };
  const phoneA = socket(rig, base, `d=${pair.token}`);
  const welcomeA = await phoneA.wait('welcome');
  const floorA = welcomeA.floor!;
  assert.ok(Array.isArray(welcomeA.building));
  assert.deepEqual(
    welcomeA.building.map((r) => r.floor),
    [floorA],
  );

  // Open a second floor for repoB; phoneB rides there while phoneA stays on floorA.
  const phoneB = socket(rig, base, `d=${pair.token}`);
  await phoneB.wait('welcome');
  phoneB.send({ t: 'floor.add', dir: repoB });
  const addedB = await phoneB.wait('floor.added', (m) => m.dir === repoB);
  const floorB = addedB.floor!;
  assert.notEqual(floorA, floorB);
  phoneB.send({ t: 'floor.go', floor: floorB });
  await phoneB.wait('floor.enter', (m) => m.floor === floorB);

  // Track state on phoneA through Store as messages arrive.
  const clientState = new Store();
  for (const m of phoneA.messages) clientState.apply(m);

  // Spawn a Droid worker on floorB while phoneA remains on floorA.
  phoneA.messages.length = 0;
  phoneB.send({ t: 'worker.spawn', kind: 'agent', deskId: 'auto', requestId: 'spawn-b', requestFloor: floorB });
  const spawned = await phoneB.wait('action.result', (m) => m.requestId === 'spawn-b');
  assert.equal(spawned.ok, true);
  const workerB = spawned.workerId!;

  // phoneA (still on floorA) receives building.worker for floorB!
  const seenOnA = await phoneA.wait('building.worker', (m) => m.floor === floorB && m.worker.id === workerB);
  assert.ok(seenOnA.worker.name.length > 0);
  for (const m of phoneA.messages) clientState.apply(m);
  assert.equal(
    clientState.building.get(floorB)?.workers.some((w) => w.id === workerB),
    true,
  );

  const ready = await phoneA.wait('building.worker', (m) => m.floor === floorB && m.worker.id === workerB && !!m.worker.sessionId);
  const sid = ready.worker.sessionId!;
  daemon.ask(sid, { requestId: 'ask-1', toolCallId: 'call-1', questions: [{ index: 1, question, options: ['hi', 'hello', 'hey'], multiSelect: false }] });
  const asking = await phoneA.wait('building.worker', (m) => m.floor === floorB && m.worker.id === workerB && m.worker.status === 'needs_input');
  clientState.apply(asking);
  const parsedMenu = clientState.building.get(floorB)?.workers.find((w) => w.id === workerB)?.menu;
  assert.equal(parsedMenu?.question, question);
  assert.equal(
    phoneA.messages.some((m) => m.t === 'screen' && m.workerId === workerB),
    false,
  );

  // A new connection on floorA gets both floors and the outstanding question in welcome.building.
  const freshPhone = socket(rig, base, `d=${pair.token}`);
  const freshWelcome = await freshPhone.wait('welcome');
  assert.equal(freshWelcome.floor, floorA);
  const freshState = new Store();
  freshState.apply(freshWelcome);
  const freshWorker = freshState.building.get(floorB)?.workers.find((w) => w.id === workerB);
  assert.equal(freshWorker?.status, 'needs_input');
  assert.equal(freshWorker?.menu?.question, question);

  // Answering from phoneA (on floorA) with a mismatched requestFloor is refused.
  phoneA.send({ t: 'worker.answer', workerId: workerB, menu: parsedMenu!, choice: 2, requestId: 'ans-wrong-floor', requestFloor: floorA });
  const wrongFloorAns = await phoneA.wait('action.result', (m) => m.requestId === 'ans-wrong-floor');
  assert.equal(wrongFloorAns.ok, false);
  assert.deepEqual(daemon.answers, []);

  // Answering from phoneA (on floorA) with requestFloor: floorB succeeds and sends a structured reply.
  phoneA.send({ t: 'worker.answer', workerId: workerB, menu: parsedMenu!, choice: 2, requestId: 'ans-ok', requestFloor: floorB });
  const okAns = await phoneA.wait('action.result', (m) => m.requestId === 'ans-ok');
  assert.equal(okAns.ok, true, okAns.error);
  assert.deepEqual(daemon.answers, [{ sessionId: sid, answers: [{ index: 1, question, answer: 'hello' }] }]);

  // Finish workerB's turn so we can fork it cross-floor from phoneA.
  daemon.notify(sid, { type: 'agent_turn_completed' });
  await phoneA.wait('building.worker', (m) => m.floor === floorB && m.worker.id === workerB && m.worker.status === 'done');

  // Reading workerB's thread from phoneA (on floorA) addresses floorB rather than failing as off-floor.
  phoneA.send({ t: 'thread.read', workerId: workerB, request: 'cross-thread' });
  const snap = await phoneA.wait('thread.snapshot', (m) => m.request === 'cross-thread');
  assert.equal(snap.workerId, workerB);

  // Forking workerB without requestFloor from floorA is refused; with requestFloor: floorB it forks on floorB!
  phoneA.send({ t: 'worker.fork', workerId: workerB, deskId: 'auto', requestId: 'fork-missing-floor' });
  assert.equal((await phoneA.wait('action.result', (m) => m.requestId === 'fork-missing-floor')).ok, false);

  phoneA.send({ t: 'worker.fork', workerId: workerB, deskId: 'auto', name: 'ScoutFork', requestId: 'fork-ok', requestFloor: floorB });
  const forked = await phoneA.wait('action.result', (m) => m.requestId === 'fork-ok');
  assert.equal(forked.ok, true, forked.error);
  assert.ok(forked.workerId);
  await phoneA.wait('building.worker', (m) => m.floor === floorB && m.worker.id === forked.workerId);

  // Dismissing both workers on floorB from phoneA (on floorA) succeeds and broadcasts building.remove!
  for (const id of [forked.workerId!, workerB]) {
    phoneA.messages.length = 0;
    phoneA.send({ t: 'worker.kill', workerId: id, cleanup: 'keep', requestId: `kill-${id}`, requestFloor: floorB });
    const killed = await phoneA.wait('action.result', (m) => m.requestId === `kill-${id}`);
    assert.equal(killed.ok, true, killed.error);
    const removed = await phoneA.wait('building.remove', (m) => m.floor === floorB && m.workerId === id);
    clientState.apply(removed);
  }
  assert.deepEqual(clientState.building.get(floorB)?.workers ?? [], []);
});
