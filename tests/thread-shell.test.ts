import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { entryAt, entryTook, liveFrom } from '../src/client/ui/thread-live-view.js';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { presentThread } from '../src/shared/thread-presentation.js';
import { relativeTime, statusElapsed, thoughtLabel, threadStatus } from '../src/shared/thread-status.js';
import type { ThreadEntry } from '../src/shared/worker-thread.js';

test('Thread status names live work and separates a clock from waiting on the owner', () => {
  const live = { status: 'pondering', working: 'executing_tool', skew: 1000, phaseSince: 80_000, tools: [{ id: 'tool:1', name: 'Execute', phase: 'running', startedAt: 57_000 }] };
  const command: ThreadEntry = { id: 'tool:1', seq: 1, role: 'assistant', kind: 'tool', input: '{"command":"npm test"}' };
  const worker = { status: 'working' as const };
  const tool = threadStatus(worker, live, [command]);
  assert.deepEqual(tool, { label: 'Running: npm test', since: 58_000, detail: undefined });
  assert.equal(statusElapsed(tool!.since!, 100_000), '42s');
  assert.equal(statusElapsed(0, 62_000), '1m 2s');
  assert.equal(statusElapsed(1000, 0), '0s');
  assert.equal(threadStatus(worker, live, [{ ...command, input: '{"command":' }])?.label, 'Running: Execute');
  assert.equal(threadStatus(worker, { ...live, tools: [{ ...live.tools[0], name: 'Read' }] }, [command])?.label, 'Running: Read');
  const thinking = { ...live, working: 'thinking', tools: [], phaseSince: 91_000 };
  const thought = threadStatus(worker, thinking, [command]);
  assert.equal(thought?.label, 'Thinking');
  assert.equal(statusElapsed(thought!.since!, 100_000), '8s');
  assert.equal(threadStatus(worker, { ...thinking, status: 'responding' }, [])?.label, 'Writing');
  assert.equal(threadStatus(worker, { ...thinking, status: 'compacting' }, [])?.label, 'Compacting conversation…');
  assert.equal(threadStatus(worker, undefined, [command])?.label, 'Working…');
  assert.deepEqual(threadStatus({ status: 'needs_input' }, { ...live, waiting: { kind: 'permission' } }, []), { label: 'Waiting for you: permission needed', waiting: true });
  assert.deepEqual(threadStatus(worker, { ...live, status: 'waiting', waiting: { kind: 'question' } }, []), { label: 'Waiting for you: answer needed', waiting: true });
  assert.equal(threadStatus({ status: 'starting' }, live, [command])?.label, 'Starting worker…');
  assert.equal(threadStatus({ status: 'idle' }, live, [command]), undefined);
});

test('Thought and relative time labels retain Factory copy', () => {
  assert.equal(thoughtLabel(25_000), 'Thought for 25s');
  assert.equal(thoughtLabel(undefined), 'Thought');
  const now = Date.UTC(2026, 0, 2, 12);
  assert.equal(relativeTime(now - 22 * 3_600_000, now), '22h ago');
  assert.equal(relativeTime(now - 30_000, now), 'now');
});

test('message times match Factory narrow formatting at past and future boundaries', () => {
  const now = Date.UTC(2026, 0, 2, 12);
  const cases = [
    [0, 'now', 'now'],
    [59_999, 'now', 'now'],
    [60_000, '1m ago', 'in 1m'],
    [60_001, '1m ago', 'in 1m'],
    [3_599_999, '59m ago', 'in 59m'],
    [3_600_000, '1h ago', 'in 1h'],
    [3_600_001, '1h ago', 'in 1h'],
    [86_399_999, '23h ago', 'in 23h'],
    [86_400_000, '1d ago', 'in 1d'],
    [86_400_001, '1d ago', 'in 1d'],
  ] as const;
  for (const [distance, past, future] of cases) {
    assert.equal(relativeTime(now - distance, now), past);
    assert.equal(relativeTime(now + distance, now), future);
  }
});

test('thread.live parsing replaces only newer views and strips autonomy, mode and side-chat metadata', () => {
  const msg = {
    t: 'thread.live',
    workerId: 'w1',
    sessionId: 's1',
    live: {
      rev: 2,
      at: 9000,
      status: 'responding',
      working: 'streaming_assistant_message',
      label: 'Retrying the model request (attempt 2)...',
      after: 'a1',
      stream: { kind: 'text', text: 'draft', since: 8000 },
      tools: [{ id: 'tool:1', name: 'Execute', startedAt: 7000, phase: 'running', output: 'ok' }],
      settings: { modelName: 'Opus 5.5', reasoningEffort: 'high', autonomyLevel: 'medium', interactionMode: 'spec' },
      side: { text: 'ignored' },
    },
  };
  const view = liveFrom(msg, 'w1', 's1', undefined, 10_000);
  assert.equal(view?.skew, 1000);
  assert.equal(view?.label, 'Retrying the model request (attempt 2)...');
  assert.equal(view?.stream?.text, 'draft');
  assert.equal(view?.tools[0]?.id, 'tool:1');
  assert.equal(view?.settings?.modelName, 'Opus 5.5');
  assert.equal('autonomyLevel' in view!.settings!, false, 'companion settings ignore autonomy metadata');
  assert.equal('interactionMode' in view!.settings!, false, 'companion settings ignore interaction mode metadata');
  assert.equal('side' in view!, false, 'side chat is absent from daemon live state');
  assert.equal(liveFrom(msg, 'w1', 's1', view, 11_000), undefined);
  assert.equal(liveFrom({ ...msg, workerId: 'other' }, 'w1', 's1', undefined), undefined);
  assert.equal(liveFrom({ ...msg, sessionId: undefined }, 'w1', 's1', undefined), undefined, 'unbound live state cannot replace a known session');
  const entry = { id: 'a1', seq: 1, role: 'assistant', kind: 'text', text: 'done', at: 8000, tookMs: 2500 } as ThreadEntry;
  assert.equal(entryAt(entry), 8000);
  assert.equal(entryTook(entry), 2500);
});

const status = browserStatus();
const chromium = status.installed ? false : `Chromium is not installed in ${status.path}`;
const worker: WorkerInfo = {
  id: 'worker-1',
  kind: 'agent',
  deskId: 'desk-1',
  name: 'Pixel',
  color: '#ee6018',
  status: 'working',
  sessionId: 'session-1',
  acked: false,
  createdBy: 'owner',
  createdAt: 1000,
  cols: 80,
  rows: 24,
  open: true,
};

async function mountShell(t: TestContext) {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bundle = buildSync({ entryPoints: [fileURLToPath(new URL('../src/client/ui/worker-thread.ts', import.meta.url))], bundle: true, format: 'iife', globalName: 'ThreadUI', write: false, target: 'es2022' }).outputFiles[0].text;
  await page.setContent('<!doctype html><div id="toasts"></div><div id="modal-root"></div>');
  await page.addStyleTag({ content: readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8') });
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.evaluate((mounted) => {
    const w = window as any;
    w.worker = mounted;
    w.sent = [];
    w.actions = [];
    Date.now = () => 100_000;
    const net = {
      send(msg: any) {
        w.sent.push(msg);
        return true;
      },
      onMessage(fn: any) {
        w.receive = fn;
        return () => {};
      },
    };
    w.thread = w.ThreadUI.mountWorkerThread(net, {
      worker: mounted,
      question: document.createElement('div'),
      draft: '',
      onDraft() {},
      send: async (msg: any) => {
        w.actions.push(msg);
        if (w.holdSend)
          return new Promise((resolve, reject) => {
            w.finishSend = resolve;
            w.failSend = reject;
          });
        return undefined;
      },
      floor: 'floor-1',
    });
    document.body.append(w.thread.element);
    w.receive({ t: 'welcome', floors: [{ id: 'floor-1', name: 'office', dir: '/tmp/office', forge: 'github' }] });
    w.thread.update(mounted, true);
    w.thread.activate(true);
  }, worker);
  return { page, errors };
}

test('Thread shell wires streaming Markdown, retry detail, thought duration, search, rewind session swap, stop turn and structured queue', { skip: chromium }, async (t) => {
  const { page, errors } = await mountShell(t);
  const entries = [
    { id: 'u1', seq: 1, role: 'user', kind: 'text', text: 'hello uniqueNeedle', at: 90_000 },
    { id: 'th1', seq: 2, role: 'assistant', kind: 'thinking', text: 'Checking invariants', at: 92_000 },
    { id: 'a1', seq: 3, role: 'assistant', kind: 'text', text: 'A recorded reply', at: 95_000 },
  ] as ThreadEntry[];
  await page.evaluate(
    ({ entries, rows }) => {
      const w = window as any;
      w.receive({ t: 'thread.snapshot', workerId: 'worker-1', request: 'push', push: true, sessionId: 'session-1', entries, hasMore: false, presentation: { version: 1, rows } });
      w.receive({
        t: 'thread.live',
        workerId: 'worker-1',
        sessionId: 'session-1',
        live: {
          rev: 1,
          at: 100_000,
          status: 'responding',
          working: 'streaming_assistant_message',
          label: 'Retrying the model request (attempt 2)...',
          after: 'a1',
          stream: { kind: 'text', text: 'Here is **bold** and `inline`:\n\n```ts\nconst x = 1;\n```', since: 99_000 },
          tools: [{ name: 'Execute', startedAt: 98_000, phase: 'running', output: 'partial output' }],
          settings: { modelName: 'Opus 5.5', reasoningEffort: 'high', autonomyLevel: 'high', interactionMode: 'spec' },
        },
      });
    },
    { entries, rows: presentThread(entries, true) },
  );
  // Streaming Markdown renders rich blocks during assistant_text_delta without plain-paragraph jumps,
  // once the word-by-word reveal has caught up with the text that arrived.
  await page.waitForFunction(() => /const x = 1;/.test(document.querySelector<HTMLElement>('.wt-stream-copy .md.wt-md pre')?.innerText ?? ''), null, { timeout: 3000 });
  assert.equal(await page.locator('.wt-stream-copy .md.wt-md strong').textContent(), 'bold');
  assert.equal(await page.locator('.wt-stream-copy .md.wt-md code').first().textContent(), 'inline');
  assert.match(await page.locator('.wt-stream-copy .md.wt-md pre').innerText(), /const x = 1;/);
  assert.equal(await page.locator('.wt-progress-detail').textContent(), 'Retrying the model request (attempt 2)...');
  assert.equal(await page.locator('.wt-progress-label').innerText(), 'Running: Execute');
  assert.equal(await page.locator('.wt-progress-elapsed').innerText(), '· 2s');
  assert.match(await page.locator('.wt-live-tool').innerText(), /partial output/);
  assert.match(await page.locator('.wt-model').innerText(), /Opus 5.5/);
  assert.equal(await page.locator('.wt-mode, .wt-side').count(), 0);
  assert.equal(await page.getByRole('button', { name: /raw tty/i }).count(), 0);
  assert.equal(await page.locator('.wt-autonomy, [aria-label*="autonomy" i], [title*="autonomy" i]').count(), 0, 'Thread exposes no autonomy display or control');

  // Completing thinking_text_complete updates tookMs in place and repaints "Thought for 12s".
  assert.equal(await page.locator('.wt-thinking .wt-thought-label').first().textContent(), 'Thought');
  const timedEntries = [entries[0], { ...entries[1], tookMs: 12_000 }, entries[2]] as ThreadEntry[];
  await page.evaluate(
    ({ entries, rows }) => {
      (window as any).receive({ t: 'thread.snapshot', workerId: 'worker-1', request: 'push', push: true, sessionId: 'session-1', entries, hasMore: false, presentation: { version: 1, rows } });
    },
    { entries: timedEntries, rows: presentThread(timedEntries, true) },
  );
  assert.equal(await page.locator('.wt-thinking .wt-thought-label').first().textContent(), 'Thought for 12s');

  // Stop turn sends worker.interrupt and never writes Escape to term.input.
  await page.getByRole('button', { name: 'Stop turn' }).click();
  await page.waitForFunction(() => (window as any).actions.some((msg: any) => msg.t === 'worker.interrupt'));
  assert.equal(await page.evaluate(() => (window as any).sent.some((msg: any) => msg.t === 'term.input')), false);

  await page.locator('.wt-scroll').press('Control+f');
  await page.locator('.wt-search-input').fill('uniqueNeedle');
  await page.waitForFunction(() => document.querySelector('.wt-search-count')?.textContent === '1 / 1 results');
  assert.equal(await page.evaluate(() => CSS.highlights.get('wt-search-current')?.size), 1);
  await page.locator('.wt-search-input').press('Escape');

  await page.evaluate(() => {
    const w = window as any;
    w.receive({ t: 'thread.live', workerId: 'worker-1', sessionId: 'session-1', live: { rev: 2, at: 100_000, status: 'idle', working: 'idle', after: 'a1', tools: [] } });
    w.thread.update({ ...w.worker, status: 'idle' }, true);
  });
  // A reply whose entry never lands stays held briefly after the turn ends, then clears.
  await page.locator('.wt-stream').waitFor({ state: 'hidden', timeout: 5000 });
  await page.locator('[data-entry="u1"]').hover();
  await page.getByRole('button', { name: 'Rewind conversation to this message' }).click();
  await page.getByText('Restore all files', { exact: true }).click();
  await page.getByRole('button', { name: 'Rewind', exact: true }).click();
  await page.waitForFunction(() => (window as any).actions.some((msg: any) => msg.t === 'worker.rewind'));
  assert.equal(await page.evaluate(() => (window as any).actions.find((msg: any) => msg.t === 'worker.rewind').restore), 'files');

  // Rewind swaps to rewound.sessionId immediately so the new session's snapshot isn't dropped before worker.update.
  await page.evaluate(() => (window as any).receive({ t: 'worker.rewound', workerId: 'worker-1', entryId: 'u1', ok: true, text: 'hello uniqueNeedle', sessionId: 'session-2' }));
  assert.equal(await page.locator('.wt-input').inputValue(), 'hello uniqueNeedle', 'the rewound prompt returns to the composer');
  await page.locator('.wt-input').fill('');

  const rewoundEntries = [{ id: 'u2', seq: 1, role: 'user', kind: 'text', text: 'hello uniqueNeedle', at: 101_000 }] as ThreadEntry[];
  await page.evaluate(
    ({ entries, rows }) => {
      const w = window as any;
      const request = w.sent.filter((msg: any) => msg.t === 'thread.read').at(-1).request;
      w.receive({ t: 'thread.snapshot', workerId: 'worker-1', request, sessionId: 'session-2', entries, hasMore: false, presentation: { version: 1, rows } });
      w.worker = { ...w.worker, sessionId: 'session-2', status: 'working' };
      w.thread.update(w.worker, true);
    },
    { entries: rewoundEntries, rows: presentThread(rewoundEntries, true) },
  );
  assert.equal(await page.locator('[data-entry="u2"]').count(), 1, 'snapshot for rewound sessionId renders immediately');

  await page.locator('.wt-input').fill('half typed');
  await page.locator('.wt-input').press('ArrowUp');
  assert.equal(await page.locator('.wt-input').inputValue(), 'hello uniqueNeedle', 'Up recalls the last prompt in place');
  await page.locator('.wt-input').press('ArrowUp');
  assert.equal(await page.locator('.wt-input').inputValue(), 'hello uniqueNeedle', 'the oldest prompt stays put');
  await page.locator('.wt-input').press('ArrowDown');
  assert.equal(await page.locator('.wt-input').inputValue(), 'half typed', 'Down returns to the draft');
  await page.locator('.wt-input').fill('');

  // Structured WorkerInfo.queue renders Steering above Queued and forwards daemon requestId on promote/edit/clear.
  await page.evaluate(() => {
    const w = window as any;
    w.worker = {
      ...w.worker,
      status: 'working',
      queue: {
        count: 2,
        moreSteering: 0,
        moreQueued: 0,
        items: [
          { id: 'req-s1', index: 1, text: 'steer next step', preview: false, moreLines: 0, source: 'droid', delivery: 'next_step' },
          { id: 'req-q1', index: 2, text: 'queue this follow-up', preview: false, moreLines: 0, source: 'droid', delivery: 'after_turn' },
        ],
      },
    };
    w.thread.update(w.worker, true);
  });
  const headings = await page.locator('.wt-queue-heading > span').allTextContents();
  assert.deepEqual(headings, ['Steering messages', 'Queued messages']);
  assert.equal(await page.locator('.wt-queued-foot').textContent(), '2 messages queued');
  assert.equal(await page.locator('[data-queued="steer:req-s1"] button[aria-label="Send now"]').count(), 0, 'steering items have no Send now button');
  await page.locator('[data-queued="queued:req-q1"]').hover();
  await page.getByRole('button', { name: 'Send now', exact: true }).click();
  await page.waitForFunction(() => (window as any).actions.some((msg: any) => msg.t === 'worker.queue' && msg.action === 'promote'));
  assert.deepEqual(
    await page.evaluate(() => {
      const msg = (window as any).actions.findLast((action: any) => action.t === 'worker.queue');
      return { action: msg.action, id: msg.id, index: msg.index, group: msg.group, text: msg.text };
    }),
    { action: 'promote', id: 'req-q1', index: 2, group: 'queued', text: 'queue this follow-up' },
  );

  await page.locator('[data-queued="queued:req-q1"] button[aria-label="Edit message"]').click();
  await page.waitForFunction(() => (window as any).actions.some((msg: any) => msg.t === 'worker.queue' && msg.action === 'delete'));
  assert.equal(await page.locator('.wt-input').inputValue(), 'queue this follow-up', 'editing deletes from daemon queue and prefills composer');
  assert.equal(await page.evaluate(() => (window as any).actions.findLast((action: any) => action.t === 'worker.queue').id), 'req-q1');

  await page.getByRole('button', { name: 'Clear all', exact: true }).click();
  await page.waitForFunction(() => (window as any).actions.some((msg: any) => msg.t === 'worker.queue' && msg.action === 'clear'));
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).thread.dispose());
});

test('rewind confirmation locks its exact choices until completion and recovers from a rejected send', { skip: chromium }, async (t) => {
  const { page, errors } = await mountShell(t);
  const entries = [{ id: 'u1', seq: 1, role: 'user', kind: 'text', text: 'Exact rewind target preview' }] as ThreadEntry[];
  await page.evaluate(
    ({ entries, rows }) => {
      const w = window as any;
      w.holdSend = true;
      w.thread.update({ ...w.worker, status: 'idle' }, true);
      w.receive({ t: 'thread.snapshot', workerId: 'worker-1', request: 'push', push: true, sessionId: 'session-1', entries, hasMore: false, presentation: { version: 1, rows } });
    },
    { entries, rows: presentThread(entries, false) },
  );
  await page.locator('[data-entry="u1"]').hover();
  await page.getByRole('button', { name: 'Rewind conversation to this message' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rewind Conversation' });
  assert.match(await dialog.innerText(), /Exact rewind target preview/);
  assert.doesNotMatch(await dialog.innerText(), /Changed files will not be reverted/);
  await page.getByRole('button', { name: 'Rewind', exact: true }).click();
  assert.equal(await dialog.locator('input:not(:disabled), button:not(:disabled)').count(), 0);
  await page.keyboard.press('Escape');
  await page.locator('.backdrop').dispatchEvent('mousedown');
  assert.equal(await dialog.isVisible(), true);
  await page.evaluate(() => (window as any).failSend(new Error('Network disconnected')));
  await page.waitForFunction(() => document.querySelector('.wt-rewind-error')?.textContent === 'Network disconnected');
  assert.equal(await dialog.locator('input:disabled, button:disabled').count(), 0);
  await page.getByRole('button', { name: 'Rewind', exact: true }).click();
  await page.evaluate(() => (window as any).finishSend(undefined));
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).thread.dispose());
});

test('the model chip changes the model and reasoning effort through worker.setting', { skip: chromium }, async (t) => {
  const { page, errors } = await mountShell(t);
  await page.evaluate(() => {
    const w = window as any;
    w.fetch = async () =>
      new Response(
        JSON.stringify({
          models: [
            { id: 'opus-5-5', displayName: 'Opus 5.5', supportedReasoningEfforts: ['low', 'medium', 'high'] },
            { id: 'sonnet-5-5', displayName: 'Sonnet 5.5' },
          ],
        }),
      );
    w.receive({
      t: 'thread.live',
      workerId: 'worker-1',
      sessionId: 'session-1',
      live: { rev: 1, at: 100_000, status: 'idle', working: 'idle', tools: [], settings: { model: 'opus-5-5', modelName: 'Opus 5.5', reasoningEffort: 'high', autonomyLevel: 'low', interactionMode: 'auto' } },
    });
  });
  assert.equal(await page.locator('.wt-mode').count(), 0);
  assert.doesNotMatch((await page.locator('.wt-model').getAttribute('title')) ?? '', /\/model|Tab/);
  await page.locator('.wt-model').click();
  await page.getByRole('menuitemradio', { name: 'Sonnet 5.5' }).waitFor();
  assert.equal(await page.getByRole('menuitemradio', { name: 'High' }).getAttribute('aria-checked'), 'true');
  await page.getByRole('menuitemradio', { name: 'Medium' }).click();
  await page.locator('.wt-model').click();
  await page.getByRole('menuitemradio', { name: 'Sonnet 5.5' }).click();
  const settings = await page.evaluate(() => (window as any).actions.filter((msg: any) => msg.t === 'worker.setting').map((msg: any) => [msg.setting, msg.value]));
  assert.deepEqual(settings, [
    ['effort', 'medium'],
    ['model', 'sonnet-5-5'],
  ]);
  await page.locator('.wt-model').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.wt-settings-menu').isVisible(), false);
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).thread.dispose());
});

test('rewind can restore only the files the owner picks', { skip: chromium }, async (t) => {
  const { page, errors } = await mountShell(t);
  const entries = [
    { id: 'u1', seq: 1, role: 'user', kind: 'text', text: 'Change two files' },
    { id: 'tool:1', seq: 2, role: 'assistant', kind: 'tool', name: 'Edit', input: JSON.stringify({ file_path: '/tmp/office/a.txt', old_str: 'a', new_str: 'b' }), output: 'ok' },
    { id: 'tool:2', seq: 3, role: 'assistant', kind: 'tool', name: 'Create', input: JSON.stringify({ file_path: '/tmp/office/c.txt', content: 'c' }), output: 'ok' },
  ] as ThreadEntry[];
  await page.evaluate(
    ({ entries, rows }) => {
      const w = window as any;
      w.thread.update({ ...w.worker, status: 'idle' }, true);
      w.receive({ t: 'thread.snapshot', workerId: 'worker-1', request: 'push', push: true, sessionId: 'session-1', entries, hasMore: false, presentation: { version: 1, rows } });
    },
    { entries, rows: presentThread(entries, false) },
  );
  await page.locator('[data-entry="u1"]').hover();
  await page.getByRole('button', { name: 'Rewind conversation to this message' }).click();
  await page.getByText('Choose files to restore...', { exact: true }).click();
  const files = page.getByRole('group', { name: 'Restore Files to Rewind Point' });
  assert.match(await files.innerText(), /office\/a\.txt\s*restore/);
  assert.match(await files.innerText(), /office\/c\.txt\s*delete/);
  await files.getByRole('checkbox').first().uncheck();
  await page.getByRole('button', { name: 'Rewind', exact: true }).click();
  await page.waitForFunction(() => (window as any).actions.some((msg: any) => msg.t === 'worker.rewind'));
  const sent = await page.evaluate(() => (window as any).actions.find((msg: any) => msg.t === 'worker.rewind'));
  assert.equal(sent.restore, 'choose');
  assert.deepEqual(sent.files, ['/tmp/office/c.txt']);
  await page.evaluate(() => (window as any).receive({ t: 'worker.rewound', workerId: 'worker-1', entryId: 'u1', ok: true, text: 'Change two files', note: 'Droid had no file changes to restore.' }));
  assert.match(
    await page
      .locator('.wt-send-hint, .wt-feedback')
      .allInnerTexts()
      .then((all) => all.join(' ')),
    /no file changes to restore/,
  );
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).thread.dispose());
});

test('slash commands: /copy opens the copy menu, /new waits for idle, /quit is blocked and /btw is absent', { skip: chromium }, async (t) => {
  const { page, errors } = await mountShell(t);
  const entries = [
    { id: 'u1', seq: 1, role: 'user', kind: 'text', text: 'first prompt' },
    { id: 'a1', seq: 2, role: 'assistant', kind: 'text', text: 'first reply' },
  ] as ThreadEntry[];
  await page.evaluate(
    ({ entries, rows }) => {
      const w = window as any;
      w.receive({ t: 'thread.snapshot', workerId: 'worker-1', request: 'push', push: true, sessionId: 'session-1', entries, hasMore: false, presentation: { version: 1, rows } });
      w.thread.update({ ...w.worker, status: 'idle' }, true);
    },
    { entries, rows: presentThread(entries, false) },
  );
  await page.locator('.wt-input').fill('/');
  assert.equal(await page.locator('.wt-slash-name', { hasText: '/btw' }).count(), 0);
  await page.locator('.wt-input').fill('/copy');
  await page.locator('.wt-input').press('Enter');
  const copy = page.getByRole('dialog', { name: 'Copy' });
  for (const choice of ['Last assistant response', 'Last user prompt', 'Current session ID', 'Full conversation transcript', 'Select range']) assert.equal(await copy.getByRole('button', { name: choice }).count(), 1, choice);
  await copy.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await page.evaluate(() => (window as any).actions.some((msg: any) => msg.t === 'worker.prompt')), false, '/copy stays in the Thread');

  await page.locator('.wt-input').fill('/quit');
  await page.locator('.wt-input').press('Enter');
  assert.match(
    await page
      .locator('.wt-send-hint, .wt-feedback')
      .allInnerTexts()
      .then((all) => all.join(' ')),
    /would end Pixel’s Droid/,
  );

  await page.evaluate(() => (window as any).thread.update({ ...(window as any).worker, status: 'working' }, true));
  await page.locator('.wt-input').fill('/new');
  await page.locator('.wt-input').press('Enter');
  assert.match(
    await page
      .locator('.wt-send-hint, .wt-feedback')
      .allInnerTexts()
      .then((all) => all.join(' ')),
    /\/new runs once Pixel finishes this turn/,
  );

  await page.evaluate(() => (window as any).thread.update({ ...(window as any).worker, status: 'idle' }, true));
  await page.locator('.wt-input').fill('/new');
  await page.locator('.wt-input').press('Enter');
  await page.waitForFunction(() => (window as any).actions.some((msg: any) => msg.t === 'worker.prompt' && msg.prompt === '/new'));
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).thread.dispose());
});
