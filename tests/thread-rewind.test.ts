import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { newWorker } from '../src/server/worker-runtime/state.js';
import { WorkerThreadReader } from '../src/server/worker-thread.js';
import { WorkerManager } from '../src/server/workers.js';
import type { ServerMsg } from '../src/shared/protocol.js';

test('reader-generated ids resolve duplicate prompts to their own seq, including string content', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'office-rewind-point-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  const source = { sessionId: 'session-one', cwd };
  const dir = path.join(root, cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
  await mkdir(dir, { recursive: true });
  const rows = [
    { type: 'session_start', id: source.sessionId, cwd },
    { type: 'message', id: 'hook', seq: 0, message: { role: 'user', content: [], visibility: 'user_only', hookEventName: 'SessionStart' } },
    { type: 'message', id: 'context-first', seq: 1, message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>hidden</system-reminder>' }], visibility: 'llm_only' } },
    { type: 'message', id: 'first', seq: 2, timestamp: '2026-11-15T03:58:31.089Z', message: { role: 'user', content: [{ type: 'text', text: 'Repeat this exact prompt' }] } },
    { type: 'message', id: 'answer', seq: 3, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    { type: 'message', id: 'second', seq: 4, timestamp: '2026-11-15T03:59:31.089Z', message: { role: 'user', content: [{ type: 'text', text: 'Repeat this exact prompt' }] } },
    { type: 'message', id: 'string', seq: 5, timestamp: '2026-11-15T04:00:31.089Z', message: { role: 'user', content: 'String content\nsecond line' } },
    { type: 'message', id: 'legacy', timestamp: '2026-11-15T04:01:31.089Z', message: { role: 'user', content: [{ type: 'text', text: 'Repeat this exact prompt' }] } },
  ];
  await writeFile(path.join(dir, `${source.sessionId}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const reader = new WorkerThreadReader(root);
  // These are the ids the Android Thread actually receives, not ids invented for rewindPoint.
  const users = (await reader.read(source)).entries.filter((entry) => entry.role === 'user' && entry.kind === 'text');
  assert.equal(users.length, 4);
  assert.notEqual(users[0].id, users[1].id);
  assert.deepEqual(await reader.rewindPoint(source, users[0].id), { number: 3, preview: 'Repeat this exact prompt', text: 'Repeat this exact prompt' });
  assert.deepEqual(await reader.rewindPoint(source, users[1].id), { number: 5, preview: 'Repeat this exact prompt', text: 'Repeat this exact prompt' });
  assert.deepEqual(await reader.rewindPoint(source, users[2].id), { number: 6, preview: 'String content second line', text: 'String content\nsecond line' });
  assert.equal(await reader.rewindPoint(source, users[3].id), undefined, 'without a seq, equal prompts cannot be selected safely');
  const assistant = (await reader.read(source)).entries.find((entry) => entry.role === 'assistant');
  assert.equal(await reader.rewindPoint(source, assistant!.id), undefined);
  assert.equal(await reader.rewindPoint(source, 'missing:text'), undefined);
});

test('a session fork during the async entry lookup refuses before touching the terminal', async () => {
  const writes: string[] = [];
  const worker = { info: { kind: 'agent', name: 'Ada', sessionId: 'forked-session', status: 'idle' }, pty: { write: (data: string) => writes.push(data) } };
  const manager = Object.create(WorkerManager.prototype) as WorkerManager;
  Reflect.set(manager, 'workers', new Map([['worker', worker]]));
  const result = await manager.rewind('worker', 'first:0', 'original-session', 'conversation');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /conversation changed/);
  assert.equal(worker.info.sessionId, 'forked-session');
  assert.equal(Reflect.get(worker, 'rewind'), undefined);
  assert.deepEqual(writes, []);
});

test('WebSocket worker.rewind and group-scoped worker.queue defer action.result until async completion', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-rewind-ws-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const cfg = loadConfig(['--home', dir, '--projects', dir, dir, '--weather', 'clear']);
  cfg.port = 0;
  const running = await startServer(cfg, { droidSessionsDir: dir });
  let stopped = false;
  t.after(async () => {
    if (!stopped) {
      stopped = true;
      const closing = once(running.server, 'close');
      running.shutdown(false);
      running.server.closeAllConnections();
      await closing;
    }
    await rm(dir, { recursive: true, force: true });
  });

  const transcript = path.join(dir, 'session.jsonl');
  const sessionId = path.basename(transcript, '.jsonl');
  await writeFile(transcript, `${[JSON.stringify({ type: 'session_start', id: sessionId, cwd: dir }), JSON.stringify({ type: 'message', id: 'u1', seq: 2, message: { role: 'user', content: 'First line\nSecond line' } })].join('\n')}\n`);

  const floor = running.floors()[0]!;
  const workersMap = Reflect.get(floor.workers, 'workers') as Map<string, unknown>;
  workersMap.set('w1', {
    ...newWorker({ id: 'w1', name: 'Ada', kind: 'agent', status: 'idle', sessionId, deskId: 'desk-1', color: '#ff5a00', cols: 120, rows: 40 }),
    daemonActive: true,
    transcript,
  });

  const rewoundCalls: { entryId: string; sessionId: string; restore: unknown }[] = [];
  floor.workers.rewind = async (_id, entryId, sid, restore) => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    rewoundCalls.push({ entryId, sessionId: sid, restore });
    return { ok: true };
  };

  let promotedIndex: number | undefined;
  floor.workers.queueState = () => ({
    count: 2,
    items: [
      { index: 1, text: 'steer first', preview: false, moreLines: 0, source: 'droid', delivery: 'steering' },
      { index: 2, text: 'queued second', preview: false, moreLines: 0, source: 'droid', delivery: 'after_turn' },
    ],
    moreSteering: 0,
    moreQueued: 0,
  });
  floor.workers.promoteQueue = async (_id, opts) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    promotedIndex = opts?.index;
    return { promoted: [], remaining: { count: 1, items: [], moreSteering: 0, moreQueued: 0 } };
  };

  const port = (running.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?client=dashboard`, { origin: base });
  t.after(() => ws.terminate());
  const messages: ServerMsg[] = [];
  const listeners = new Set<() => void>();
  ws.on('message', (data) => {
    messages.push(JSON.parse(String(data)));
    for (const fn of listeners) fn();
  });
  const wait = <T extends ServerMsg['t']>(type: T, predicate: (msg: Extract<ServerMsg, { t: T }>) => boolean = () => true) =>
    new Promise<Extract<ServerMsg, { t: T }>>((resolve, reject) => {
      const check = () => {
        const found = messages.find((m): m is Extract<ServerMsg, { t: T }> => m.t === type && predicate(m as Extract<ServerMsg, { t: T }>));
        if (!found) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve(found);
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`Timed out waiting for ${type}`));
      }, 5000);
      listeners.add(check);
      check();
    });

  await wait('welcome');
  ws.send(JSON.stringify({ t: 'worker.rewind', requestId: 'req-rewind', workerId: 'w1', entryId: 'u1:text', restore: 'files' }));
  const [rewoundMsg, rewindAck] = await Promise.all([wait('worker.rewound', (m) => m.workerId === 'w1'), wait('action.result', (m) => m.requestId === 'req-rewind')]);
  assert.equal(rewindAck.ok, true, rewindAck.error);
  assert.equal(rewoundMsg.ok, true);
  assert.equal(rewoundMsg.text, 'First line\nSecond line');
  assert.deepEqual(rewoundCalls, [{ entryId: 'u1:text', sessionId, restore: 'files' }]);

  ws.send(JSON.stringify({ t: 'worker.queue', requestId: 'req-queue', workerId: 'w1', action: 'promote', index: 1, group: 'queued', text: 'queued second' }));
  const queueAck = await wait('action.result', (m) => m.requestId === 'req-queue');
  assert.equal(queueAck.ok, true, queueAck.error);
  assert.equal(promotedIndex, 2);
});
