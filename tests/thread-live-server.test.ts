import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readSessionSettings, ThreadLiveTracker, type ThreadLiveInputs } from '../src/server/thread-live.js';
import type { ThreadEntry } from '../src/shared/worker-thread.js';

const entry = (id: string, extra: Partial<ThreadEntry> = {}): ThreadEntry => ({ id, role: 'assistant', kind: 'text', text: 'Earlier', seq: 0, ...extra });
const base = (): ThreadLiveInputs => ({ sessionId: 'session', status: 'idle', activeTool: new Map() });

test('session settings keep model, effort, interaction mode and autonomy without non-TUI context meters', () => {
  assert.deepEqual(
    readSessionSettings({
      model: 'claude-haiku-5-5',
      reasoningEffort: 'low',
      interactionMode: 'auto',
      autonomyLevel: 'high',
      autonomyMode: 'auto-high',
      tokenUsage: { inputTokens: 10, outputTokens: 20, cacheCreationTokens: 30, cacheReadTokens: 40, thinkingTokens: 5, factoryCredits: 0.25 },
      inclusiveTokenUsage: { inputTokens: 100, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 },
      lastCallTokenUsage: { inputTokens: 1000, outputTokens: 50, cacheCreationTokens: 100, cacheReadTokens: 2000, thinkingTokens: 20 },
      assistantActiveTimeMs: 12345,
    }),
    {
      model: 'claude-haiku-5-5',
      reasoningEffort: 'low',
      interactionMode: 'auto',
      autonomyLevel: 'high',
      autonomyMode: 'auto-high',
    },
  );
  assert.deepEqual(readSessionSettings({ tokenUsage: { unknown: 99 }, inclusiveTokenUsage: {}, lastCallTokenUsage: { futureField: 1 }, assistantActiveTimeMs: Infinity }), {});
});

test('an earlier turn saying the same words cannot suppress the current live response', async () => {
  const tracker = new ThreadLiveTracker(() => 5000);
  const inputs = { ...base(), status: 'working' as const, daemon: { working: 'streaming_assistant_message' as const, stream: { kind: 'text' as const, text: 'OK', since: 5000 } } };
  const oldReply = entry('old', { text: 'OK' });
  const prompt = entry('new', { role: 'user', text: 'Reply with OK' });
  const current = await tracker.compute('w', inputs, [oldReply, prompt]);
  assert.equal(current.live.stream?.text, 'OK');
  const canonical = await tracker.compute('w', inputs, [oldReply, prompt, entry('landed', { text: 'OK' })]);
  assert.equal(canonical.live.stream, undefined);
});

test('idle live state still carries settings, and an unchanged computation keeps its rev', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'office-live-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  await writeFile(path.join(root, 'session.settings.json'), JSON.stringify({ model: 'claude-haiku-5-5', reasoningEffort: 'low', lastCallTokenUsage: { inputTokens: 400, cacheReadTokens: 600, cacheCreationTokens: 0, outputTokens: 0 } }));
  let now = 1000;
  const tracker = new ThreadLiveTracker(() => now);
  const inputs = { ...base(), modelName: () => 'Haiku 5.5' };
  const first = await tracker.compute('w', inputs, [entry('last')], file);
  assert.equal(first.changed, true);
  assert.equal(first.live.status, 'idle');
  assert.equal(first.live.settings?.model, 'claude-haiku-5-5');
  assert.equal(first.live.settings?.modelName, 'Haiku 5.5');
  assert.equal(first.live.settings?.reasoningEffort, 'low');
  assert.equal('context' in (first.live.settings ?? {}), false);
  assert.equal(first.live.after, 'last');
  now += 1000;
  const second = await tracker.compute('w', inputs, [entry('last')], file);
  assert.equal(second.changed, false);
  assert.equal(second.live.rev, first.live.rev);
});

test('daemon settings win over a settings file Droid has not rewritten yet', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'office-live-stale-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  await writeFile(path.join(root, 'session.settings.json'), JSON.stringify({ model: 'claude-sonnet-4-5', reasoningEffort: 'high', interactionMode: 'auto' }));
  const names: Record<string, string> = { 'claude-sonnet-4-5': 'Sonnet 4.5', 'claude-haiku-5-5': 'Haiku 5.5' };
  const tracker = new ThreadLiveTracker(() => 1000);
  const inputs: ThreadLiveInputs = {
    ...base(),
    daemon: { working: 'idle', settings: { model: 'claude-haiku-5-5', reasoningEffort: 'xhigh', interactionMode: 'auto' } },
    modelName: (id) => names[id],
  };
  const { live } = await tracker.compute('w', inputs, [entry('last')], file);
  assert.deepEqual(live.settings, { model: 'claude-haiku-5-5', modelName: 'Haiku 5.5', reasoningEffort: 'xhigh', interactionMode: 'auto' });
  // Without daemon settings, the last settings on disk are still available.
  const unknown = await new ThreadLiveTracker(() => 1000).compute('w', { ...inputs, daemon: undefined }, [entry('last')], file);
  assert.equal(unknown.live.settings?.model, 'claude-sonnet-4-5');
  assert.equal(unknown.live.settings?.reasoningEffort, 'high');
});

test('a running Execute gets its canonical id, daemon start and live output', async () => {
  const tracker = new ThreadLiveTracker(() => 5000);
  const tool = entry('tool:call', { kind: 'tool', name: 'Execute', input: '{"command":"printf ticks"}', at: 4000 });
  const inputs: ThreadLiveInputs = {
    ...base(),
    status: 'working',
    workingSince: 3000,
    activeTool: new Map([['session', { tool: 'Execute', input: { command: 'printf ticks' }, startedAt: 4100 }]]),
    daemon: { working: 'executing_tool', tools: [{ toolUseId: 'call', name: 'Execute', startedAt: 4100, output: 'tick 1\ntick 2' }] },
  };
  const { live } = await tracker.compute('w', inputs, [tool]);
  assert.equal(live.status, 'pondering');
  assert.equal(live.working, 'executing_tool');
  assert.deepEqual(live.tools, [{ id: 'tool:call', name: 'Execute', startedAt: 4100, phase: 'running', output: 'tick 1\ntick 2' }]);
  assert.equal(live.turnStartedAt, 3000);
});

test('an ExitSpecMode wait attaches to its tool row, and rewind is explicit', async () => {
  const tracker = new ThreadLiveTracker(() => 5000);
  const waiting = entry('tool:spec', { kind: 'tool', name: 'ExitSpecMode' });
  const inputs: ThreadLiveInputs = { ...base(), status: 'needs_input', ask: { kind: 'permission', tool: 'ExitSpecMode' }, activeTool: new Map() };
  const { live } = await tracker.compute('w', inputs, [waiting]);
  assert.equal(live.status, 'waiting');
  assert.deepEqual(live.waiting, { kind: 'spec', toolId: 'tool:spec' });
  assert.equal(live.tools[0].phase, 'waiting_permission');
  const rewinding = await tracker.compute('w', { ...inputs, rewind: { entryId: 'abc:text', since: 4000 } }, [waiting]);
  assert.equal(rewinding.live.status, 'idle');
  assert.equal(rewinding.live.label, 'Rewinding conversation...');
  assert.deepEqual(rewinding.live.rewind, { entryId: 'abc:text', since: 4000 });
  assert.equal(rewinding.changed, true);
  assert.equal(rewinding.live.working, 'idle');
  assert.deepEqual(rewinding.live.tools, []);
  assert.equal(rewinding.live.waiting, undefined);
});

test('daemon live stream tracks thinking/text deltas, dedupes landed entries, and links pending vs canonical tools', async () => {
  const tracker = new ThreadLiveTracker(() => 6000);
  const prompt = entry('u1:0', { role: 'user', text: 'Run tests' });

  // 1. Thinking delta + unlanded pending tool (no id yet so client renders in pendingTools).
  const thinkingInputs: ThreadLiveInputs = {
    ...base(),
    status: 'working',
    workingSince: 5000,
    daemon: {
      working: 'thinking',
      stream: { kind: 'thinking', messageId: 'm1', blockIndex: 0, since: 5100, text: 'Checking test suite...' },
      tools: [{ toolUseId: 'call-1', name: 'Execute', startedAt: 5200, output: 'line 1\nline 2', more: 5 }],
      settings: { model: 'claude-opus-4-6', reasoningEffort: 'high', interactionMode: 'auto', autonomyLevel: 'high' },
    },
    modelName: (id) => (id === 'claude-opus-4-6' ? 'Opus 4.6' : undefined),
  };
  const step1 = await tracker.compute('w', thinkingInputs, [prompt]);
  assert.equal(step1.live.status, 'pondering');
  assert.equal(step1.live.working, 'thinking');
  assert.deepEqual(step1.live.stream, { kind: 'thinking', text: 'Checking test suite...', since: 5100 });
  assert.deepEqual(step1.live.tools, [
    {
      name: 'Execute',
      startedAt: 5200,
      phase: 'running',
      output: 'line 1\nline 2',
      more: 5,
    },
  ]);
  assert.deepEqual(step1.live.settings, {
    model: 'claude-opus-4-6',
    modelName: 'Opus 4.6',
    reasoningEffort: 'high',
    interactionMode: 'auto',
    autonomyLevel: 'high',
  });

  // 2. Once tool:call-1 lands in entries, live tool carries canonical id 'tool:call-1'; assistant text delta dedupes once landed.
  const landedTool = entry('tool:call-1', { kind: 'tool', name: 'Execute', input: '{"command":"npm test"}', at: 5200 });
  const textInputs: ThreadLiveInputs = {
    ...thinkingInputs,
    daemon: {
      ...thinkingInputs.daemon!,
      working: 'streaming_assistant_message',
      stream: { kind: 'text', messageId: 'm2', blockIndex: 0, since: 5500, text: 'All tests passed.' },
    },
  };
  const step2 = await tracker.compute('w', textInputs, [prompt, landedTool]);
  assert.equal(step2.live.tools[0]?.id, 'tool:call-1');
  assert.equal(step2.live.stream?.text, 'All tests passed.');

  const step3 = await tracker.compute('w', textInputs, [prompt, landedTool, entry('m2:0', { text: 'All tests passed.' })]);
  assert.equal(step3.live.stream, undefined);
});

test('daemon llm_retry label surfaces while working, clears at rest, and AskUser sets waiting question state', async () => {
  const tracker = new ThreadLiveTracker(() => 7000);
  const retrying = await tracker.compute(
    'w',
    {
      ...base(),
      status: 'working',
      daemon: {
        working: 'thinking',
        tools: [],
        label: 'Retrying the model request (attempt 2)...',
      },
    },
    [],
  );
  assert.equal(retrying.live.status, 'pondering');
  assert.equal(retrying.live.label, 'Retrying the model request (attempt 2)...');

  const settled = await tracker.compute(
    'w',
    {
      ...base(),
      status: 'done',
      daemon: {
        working: 'idle',
        tools: [],
        label: 'Retrying the model request (attempt 2)...',
      },
    },
    [],
  );
  assert.equal(settled.live.status, 'idle');
  assert.equal(settled.live.label, undefined);

  const asking = await tracker.compute(
    'w',
    {
      ...base(),
      status: 'needs_input',
      ask: { kind: 'question', questions: [{ question: 'Deploy now?', options: ['Yes', 'No'], multiSelect: false }] },
      daemon: { working: 'waiting_for_tool_confirmation', tools: [] },
    },
    [],
  );
  assert.equal(asking.live.status, 'waiting');
  assert.deepEqual(asking.live.waiting, { kind: 'question' });
});
