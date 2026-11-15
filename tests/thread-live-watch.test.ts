import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ThreadWatchHub, type ThreadWatchMsg, type WatchedThreadTarget } from '../src/server/thread-watch.js';
import { WorkerThreadReader } from '../src/server/worker-thread.js';
import type { ThreadLive } from '../src/shared/thread-live.js';

const waitUntil = async (predicate: () => boolean) => {
  const end = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timed out waiting for a thread message');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};
const liveState = (rev: number, label?: string): ThreadLive => ({ rev, at: 1000 + rev, status: 'idle', working: 'idle', ...(label ? { label } : {}), tools: [], settings: { model: 'claude-haiku-5-5' } });

test('watch starts with idle live settings and a repaint pushes a changed live state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'office-live-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  const source = { sessionId: 'session-one', cwd };
  const dir = path.join(root, cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${source.sessionId}.jsonl`), `${JSON.stringify({ type: 'session_start', id: source.sessionId, cwd })}\n`);
  const target: WatchedThreadTarget = { kind: 'local', floorId: null, busy: false, local: source };
  const sent: ThreadWatchMsg[] = [];
  let current = liveState(1);
  const hub = new ThreadWatchHub({
    workerThreads: new WorkerThreadReader(root),
    resolveWorker: () => target,
    live: async () => current,
    send: (_client, msg) => sent.push(msg),
    localCoalesceMs: 10,
  });
  t.after(() => hub.close());
  hub.watch('client', 'worker', true);
  await waitUntil(() => sent.some((msg) => msg.t === 'thread.live'));
  const first = sent.find((msg) => msg.t === 'thread.live');
  assert.ok(first?.t === 'thread.live');
  assert.equal(first.live.settings?.model, 'claude-haiku-5-5');
  assert.equal(first.live.status, 'idle');
  const count = sent.filter((msg) => msg.t === 'thread.live').length;
  hub.notifyWorker('worker');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(sent.filter((msg) => msg.t === 'thread.live').length, count, 'the same rev is not pushed again');
  current = liveState(2, 'Streaming...');
  hub.screenChanged('worker');
  await waitUntil(() => sent.some((msg) => msg.t === 'thread.live' && msg.live.rev === 2));
});

test('main and child watches push separate snapshots, with child echoed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'office-child-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  const source = { sessionId: 'session-one', cwd };
  const child = '0b3a5f1e-7c1d-4d55-9a9e-2f8c7a6b5c4d';
  const dir = path.join(root, cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
  await mkdir(dir, { recursive: true });
  const row = (id: string, text: string) => ({ type: 'message', id, timestamp: '2026-11-15T03:58:31.089Z', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  await writeFile(path.join(dir, `${source.sessionId}.jsonl`), `${JSON.stringify({ type: 'session_start', id: source.sessionId, cwd })}\n${JSON.stringify(row('parent', 'Parent'))}\n`);
  await writeFile(path.join(dir, `${child}.jsonl`), `${JSON.stringify({ type: 'session_start', id: child, callingSessionId: source.sessionId, callingToolUseId: 'call-task' })}\n${JSON.stringify(row('child', 'Child'))}\n`);
  const target: WatchedThreadTarget = { kind: 'local', floorId: null, busy: false, local: source };
  const sent: ThreadWatchMsg[] = [];
  const hub = new ThreadWatchHub({ workerThreads: new WorkerThreadReader(root), resolveWorker: () => target, send: (_client, msg) => sent.push(msg), localCoalesceMs: 10 });
  t.after(() => hub.close());
  hub.watch('client', 'worker', true);
  hub.watch('client', 'worker', true, child);
  await waitUntil(() => sent.filter((msg) => msg.t === 'thread.snapshot').length >= 2);
  const snapshots = sent.filter((msg) => msg.t === 'thread.snapshot');
  assert.ok(snapshots.some((msg) => msg.t === 'thread.snapshot' && !msg.child && msg.entries[0]?.text === 'Parent'));
  assert.ok(snapshots.some((msg) => msg.t === 'thread.snapshot' && msg.child === child && msg.sessionId === child && msg.entries[0]?.text === 'Child'));
  hub.watch('client', 'worker', false, child);
  assert.equal(hub.watchedCount('client'), 1, 'turning off the child leaves the main watch');
});
