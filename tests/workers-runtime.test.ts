import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { Worktrees } from '../src/server/worktrees.js';
import { applyDaemonNotification, searchDaemonWorker, tailDaemonWorker } from '../src/server/worker-runtime/hooks.js';
import { WorkerLaunchSettings } from '../src/server/worker-runtime/launch-settings.js';
import { WorkerStateStore } from '../src/server/worker-runtime/persistence.js';
import { newWorker, type Worker } from '../src/server/worker-runtime/state.js';

function info(): WorkerInfo {
  return { id: 'worker', kind: 'agent', name: 'Pixel', deskId: 'desk-1', color: '#ff8a5b', status: 'working', sessionId: 'session', acked: true, createdBy: 'test', createdAt: 1, cols: 136, rows: 39, open: false };
}

test('daemon system prompts are computed without writing Droid settings or hooks', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'worker-settings-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let system: string | undefined = 'system brief';
  writeFileSync(path.join(root, 'droid-hooks.json'), '{}');
  writeFileSync(path.join(root, 'hook.cjs'), '// stale');
  const settings = new WorkerLaunchSettings(root, {
    systemPrompt: () => () => system,
    visitsOn: () => false,
    plain: true,
    trees: new Worktrees(root, true),
  });
  assert.equal(existsSync(path.join(root, 'droid-hooks.json')), false, 'daemon launch settings clean up stale hook files on init');
  assert.equal(existsSync(path.join(root, 'hook.cjs')), false);
  const worker = info();
  assert.equal(settings.systemPromptText(worker), 'system brief');
  assert.equal(existsSync(path.join(root, `system-${worker.id}.md`)), false, 'systemPromptText does not write a disk file');
  system = undefined;
  assert.equal(settings.systemPromptText(worker), undefined);
});

test('worker state recovery keeps shell terminal claims, daemon session state, pending forks, notices and retired seats', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'worker-state-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worker = newWorker(info());
  const shellWorker = newWorker({ ...info(), id: 'shell-1', kind: 'shell', name: 'Sandy 🐚', deskId: 'desk-2', sessionId: undefined });
  shellWorker.pty = { id: 'pty-shell', pid: 2, write() {}, resize() {}, kill() {}, onData() {}, onExit() {} };
  const context = { deskless: false, cols: 136, rows: 39, color: '#ff8a5b', buildingKnown: (id: string) => id === 'orchestrator', heldDesk: () => false };
  const state = new WorkerStateStore(root, context);
  worker.pty = undefined;
  worker.daemonActive = true;
  worker.info.activeModel = 'claude-opus-4-6';
  worker.info.activeEffort = 'high';
  worker.info.lead = 'orchestrator';
  worker.info.status = 'working';
  const fork = newWorker({ ...info(), id: 'fork-1', deskId: 'desk-3', sessionId: undefined });
  fork.pendingFork = { sessionId: 'source-session', prompt: 'fork task' };
  worker.outbox = ['unread notice'];
  state.save([worker, shellWorker, fork], { closing: false, stopping: false, onShutdown: false });
  const file = path.join(root, 'workers.json');
  const retired = { id: 'retired', deskId: 'removed-seat', name: 'Never relaunch', retained: 'unchanged' };
  writeFileSync(file, JSON.stringify([...JSON.parse(readFileSync(file, 'utf8')), retired]));
  const restored = new WorkerStateStore(root, context);
  const workers = new Map<string, Worker>();
  restored.restore(workers);
  assert.equal(workers.size, 3);
  const recovered = workers.get(worker.info.id)!;
  assert.equal(recovered.info.status, 'offline');
  assert.equal(recovered.info.lead, 'orchestrator');
  assert.equal(recovered.info.activeModel, 'claude-opus-4-6');
  assert.equal(recovered.info.activeEffort, 'high');
  assert.deepEqual(workers.get(fork.info.id)?.pendingFork, fork.pendingFork);
  assert.equal(recovered.saved, undefined, 'daemon agent workers never persist a PTY claim');
  assert.equal(recovered.savedDaemon?.status, 'working');
  assert.deepEqual(recovered.savedDaemon?.outbox, worker.outbox);
  assert.equal(recovered.interrupted, true);
  const recoveredShell = workers.get(shellWorker.info.id)!;
  assert.equal(recoveredShell.saved?.ptyId, 'pty-shell');
  restored.save(workers.values(), { closing: false, stopping: false, onShutdown: false });
  assert.deepEqual(
    JSON.parse(readFileSync(file, 'utf8')).find((row: { id: string }) => row.id === retired.id),
    retired,
  );
});

test('daemon notifications track TodoWrite across compaction, clear llm_retry on progress, and feed tail/search', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000 });
  const worker = newWorker(info());
  const calls: string[] = [];
  worker.pty = undefined;
  worker.daemonActive = true;
  const send = (notification: Record<string, unknown>, sid = 'session') =>
    applyDaemonNotification(worker, sid, notification, {
      setStatus: (w, status) => {
        w.info.status = status;
        calls.push(`status:${status}`);
      },
      clockWork: () => {},
      emitUpdate: () => calls.push('update'),
      persist: () => calls.push('persist'),
      syncBranch: async () => {},
      tool: (_id, r) => calls.push(`tool:${r.changes ? 'c' : ''}${r.board ? 'b' : ''}`),
      notePrompt: (_w, text) => calls.push(`prompt:${text}`),
      setTitle: (_w, title) => {
        worker.info.title = title;
      },
      beforeStop: () => undefined,
      nextTurn: () => calls.push('nextTurn'),
      sendNudge: (_w, text) => calls.push(`nudge:${text}`),
    });

  // 1. Thinking duration + llm_retry cleared on assistant_text_delta.
  send({ type: 'thinking_text_delta', messageId: 'm1', blockIndex: 0, textDelta: 'Analyzing...' });
  send({ type: 'thinking_text_complete', messageId: 'm1', blockIndex: 0, durationMs: 1850 });
  assert.equal(worker.thinkingDurations.get('m1:0'), 1850);

  send({ type: 'llm_retry', attempt: 2, maxRetries: 5, delayMs: 2000 });
  assert.equal(worker.retryState?.detail, 'Retrying the model request (attempt 2)...');
  send({ type: 'assistant_text_delta', messageId: 'm1', blockIndex: 1, textDelta: 'Fixed it.' });
  assert.equal(worker.retryState, undefined, 'progress clears llm_retry');

  // 2. TodoWrite updates worker.info.todos on non-error tool_result and survives session_compacted!
  send({
    type: 'tool_call',
    toolUse: {
      id: 'todo-1',
      name: 'TodoWrite',
      input: {
        todos: [
          { content: 'Wire daemon', status: 'completed' },
          { content: 'Write tests', status: 'in_progress' },
        ],
      },
    },
  });
  assert.equal(worker.info.todos, undefined, 'TodoWrite waits for non-error tool_result');
  send({ type: 'tool_result', toolResult: { tool_use_id: 'todo-1', content: 'Updated todos', is_error: false } });
  assert.deepEqual(worker.info.todos, { done: 1, total: 2, current: 'Write tests' });

  send({ type: 'session_compacted', cutoffMessageId: 'm1', summaryText: 'Summary' });
  assert.deepEqual(worker.info.todos, { done: 1, total: 2, current: 'Write tests' }, 'pre-cutoff TodoWrite survives session_compacted');

  // 3. Queue sync + tail + search.
  send({
    type: 'queued_messages_changed',
    messages: [
      { requestId: 'q-1', text: 'Steer now', queuePlacement: 'end_of_turn' },
      { requestId: 'q-2', text: 'Run lint after', queuePlacement: 'end_of_loop' },
    ],
  });
  assert.equal(worker.info.queue?.count, 2);
  assert.equal(worker.info.queue?.items[0]?.delivery, 'steering');
  assert.equal(worker.info.queue?.items[1]?.delivery, 'after_turn');

  send({ type: 'create_message', message: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Ship DOFF-934' }] } });
  send({ type: 'create_message', message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'All daemon hooks green' }] } });
  const tail = tailDaemonWorker(worker, 10);
  assert.match(tail ?? '', /Ship DOFF-934/);
  assert.match(tail ?? '', /All daemon hooks green/);
  const hits = searchDaemonWorker(worker, 'daemon hooks', 5);
  assert.equal(hits.hits.length, 1);
  assert.match(hits.hits[0]!.text, /All daemon hooks green/);
});

test('a closed worker state store cannot overwrite successor state except for its explicit shutdown save', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'worker-state-close-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = new WorkerStateStore(root, { deskless: false, cols: 136, rows: 39, color: '#ff8a5b', buildingKnown: () => false, heldDesk: () => false });
  const worker = newWorker(info());
  const file = path.join(root, 'workers.json');
  writeFileSync(file, 'successor state');
  state.save([worker], { closing: true, stopping: false, onShutdown: false });
  assert.equal(readFileSync(file, 'utf8'), 'successor state');
  state.save([worker], { closing: true, stopping: true, onShutdown: true });
  assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0].midTurn, false);
});
