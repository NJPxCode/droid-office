import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { activeWorkerMenu } from '../src/client/ui/question-slot.js';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import { ORCHESTRATOR_ID } from '../src/shared/mission-control.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { effortName } from '../src/shared/thread-live.js';
import { rewindFilesSince } from '../src/shared/thread-rewind.js';
import { threadCopyText, threadPrompts, threadTurns } from '../src/shared/thread-turns.js';
import type { ThreadEntry } from '../src/shared/worker-thread.js';

const tool = (id: string, seq: number, name: string, input: object, error = false): ThreadEntry => ({ id, seq, role: 'assistant', kind: 'tool', name, input: JSON.stringify(input), error });
const user = (id: string, seq: number, text: string): ThreadEntry => ({ id, seq, role: 'user', kind: 'text', text });
const reply = (id: string, seq: number, text: string): ThreadEntry => ({ id, seq, role: 'assistant', kind: 'text', text });

test('the files a rewind offers are those changed after the message, a created one deleted however often it was edited', () => {
  const entries = [
    tool('t0', 0, 'Edit', { file_path: '/p/early.ts', old_str: 'a', new_str: 'b' }),
    user('u1', 1, 'Change things'),
    tool('t1', 2, 'Create', { file_path: '/p/new.ts', content: 'x' }),
    tool('t2', 3, 'Edit', { file_path: '/p/a.ts', old_str: 'a', new_str: 'b' }),
    tool('t3', 4, 'Edit', { file_path: '/p/failed.ts', old_str: 'a', new_str: 'b' }, true),
    user('u2', 5, 'More'),
    tool('t4', 6, 'Edit', { file_path: '/p/new.ts', old_str: 'x', new_str: 'y' }),
  ];
  assert.deepEqual(
    rewindFilesSince(entries, 'u1').map(({ path, action }) => ({ path, action })),
    [
      { path: '/p/new.ts', action: 'delete' },
      { path: '/p/a.ts', action: 'restore' },
    ],
  );
  assert.deepEqual(
    rewindFilesSince(entries, 'u2').map(({ path, action }) => ({ path, action })),
    [{ path: '/p/new.ts', action: 'restore' }],
  );
  assert.deepEqual(rewindFilesSince(entries, 'missing'), []);
});

test('reasoning effort ids map to Factory labels', () => {
  assert.equal(effortName('xhigh'), 'Extra high');
  assert.equal(effortName('none'), 'Off');
  assert.equal(effortName('off'), 'Off');
  assert.equal(effortName('medium'), 'Medium');
  assert.equal(effortName('turbo'), 'turbo');
});

test('turns, prompt history and /copy read the conversation as Droid does', () => {
  const entries = [reply('a0', 0, 'Hello'), user('u1', 1, 'Fix the build'), reply('a1', 2, 'Looking'), reply('a2', 3, 'Fixed'), user('u2', 4, '  Thanks  '), user('u3', 5, 'Fix the build')];
  assert.deepEqual(threadTurns(entries), [
    { prompt: '', replies: ['Hello'] },
    { prompt: 'Fix the build', replies: ['Looking', 'Fixed'] },
    { prompt: 'Thanks', replies: [] },
    { prompt: 'Fix the build', replies: [] },
  ]);
  assert.deepEqual(threadPrompts(entries), ['Fix the build', 'Thanks']);
  assert.deepEqual(threadPrompts(entries, 1), ['Fix the build']);
  assert.equal(threadCopyText(entries, 'reply'), 'Looking\n\nFixed');
  assert.equal(threadCopyText(entries, 'prompt'), 'Fix the build');
  assert.equal(threadCopyText(entries, 'session', { sessionId: 's1' }), 's1');
  assert.equal(threadCopyText(entries, 'session'), undefined);
  assert.equal(threadCopyText(entries, 'turns', { turns: 2 }), 'User: Thanks\n\nUser: Fix the build');
  assert.equal(threadCopyText(entries, 'transcript'), 'Droid: Hello\n\nUser: Fix the build\n\nDroid: Looking\n\nDroid: Fixed\n\nUser: Thanks\n\nUser: Fix the build');
  assert.equal(threadCopyText([], 'transcript'), undefined);
});

test('activeWorkerMenu reads structured local and cloud AskUser menus only while waiting on input', () => {
  const menu = { question: 'Pick one', choices: [{ number: 1, label: 'Alpha' }], freeText: true };
  const base: WorkerInfo = {
    id: 'pixel',
    name: 'Pixel',
    kind: 'agent',
    deskId: 'desk-1',
    color: '#ee6018',
    status: 'needs_input',
    acked: true,
    createdBy: 'owner',
    createdAt: 0,
    cols: 80,
    rows: 24,
    open: false,
  };
  assert.equal(activeWorkerMenu(undefined), undefined);
  assert.deepEqual(activeWorkerMenu({ ...base, menu }), menu);
  assert.deepEqual(activeWorkerMenu({ ...base, kind: 'cloud', cloud: { computerId: 'c1', computerName: 'mac-mini', autonomy: 'high', menu } }), menu);
  assert.equal(activeWorkerMenu({ ...base, status: 'working', menu }), undefined);
  assert.equal(activeWorkerMenu({ ...base, kind: 'shell', menu }), undefined);
});

const status = browserStatus();

test('Changes and Mission Control surfaces expose Thread for Droid workers and Diff | Log only for shell', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bundle = buildSync({
    stdin: {
      contents: "export { openChanges } from './src/client/ui/changes'; export { openOrchestrator } from './src/client/ui/mission-control'; export { store } from './src/client/state';",
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    bundle: true,
    format: 'iife',
    globalName: 'ClientSurfaces',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  await page.route('http://surfaces.test/**', (route) => {
    if (route.request().url().includes('/api/changes')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ branch: 'feat/test', prBase: 'main', ahead: 0, behind: 0, files: [] }) });
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="modal-root"></div><div id="toasts"></div>' });
  });
  await page.goto('http://surfaces.test/');
  await page.setContent('<!doctype html><div id="modal-root"></div><div id="toasts"></div>');
  await page.addStyleTag({ content: readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8') });
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.evaluate((orchId) => {
    const w = window as any;
    const { store, openChanges } = w.ClientSurfaces;
    w.orchId = orchId;
    w.net = { up: true, send: () => true, request: async () => ({ ok: true }), onMessage: () => () => {}, onStatus: () => () => {} };
    store.workers.set('pixel', {
      id: 'pixel',
      name: 'Pixel',
      kind: 'agent',
      deskId: 'desk-1',
      color: '#ee6018',
      status: 'idle',
      acked: true,
      createdBy: 'owner',
      createdAt: 0,
      cols: 80,
      rows: 24,
      open: false,
    });
    store.workers.set('zsh', {
      id: 'zsh',
      name: 'Shell 1',
      kind: 'shell',
      deskId: 'desk-2',
      color: '#6ad99b',
      status: 'idle',
      acked: true,
      createdBy: 'owner',
      createdAt: 0,
      cols: 80,
      rows: 24,
      open: false,
    });
    openChanges(w.net, 'pixel', () => {});
  }, ORCHESTRATOR_ID);

  const changes = page.locator('.modal.desk-changes');
  await changes.waitFor({ state: 'visible' });
  assert.equal(await changes.getByRole('group', { name: 'Show' }).count(), 0, 'Droid worker Changes modal hides Diff | Log PTY switcher');
  assert.equal(await changes.getByRole('button', { name: 'Thread', exact: true }).count(), 1);
  assert.equal(await changes.getByRole('button', { name: 'Terminal', exact: true }).count(), 0);
  await changes.locator('header > button.close').click();

  await page.evaluate(() => {
    const w = window as any;
    w.ClientSurfaces.openChanges(w.net, 'zsh', () => {});
  });
  await changes.waitFor({ state: 'visible' });
  assert.equal(await changes.getByRole('group', { name: 'Show' }).count(), 1, 'shell worker Changes modal keeps Diff | Log PTY switcher');
  assert.equal(await changes.getByRole('button', { name: 'Terminal', exact: true }).count(), 1);
  await changes.locator('header > button.close').click();

  await page.evaluate((orchId) => {
    const w = window as any;
    const { store, openOrchestrator } = w.ClientSurfaces;
    store.missionControl = {
      orchestrator: {
        settings: { on: true },
        agent: {
          worker: {
            id: orchId,
            name: 'Orchestrator',
            kind: 'agent',
            deskId: '',
            color: '#ee6018',
            status: 'needs_input',
            sessionId: 'orch-1',
            acked: true,
            createdBy: '',
            createdAt: 0,
            cols: 80,
            rows: 24,
            open: false,
          },
          team: [],
        },
        team: [],
      },
      bots: [],
    };
    openOrchestrator(w.net, { terminal() {}, settings() {} });
  }, ORCHESTRATOR_ID);
  const promptModal = page.locator('.modal');
  await promptModal.waitFor({ state: 'visible' });
  assert.equal(await promptModal.getByRole('button', { name: 'Thread', exact: true }).count(), 1);
  assert.equal(await promptModal.getByRole('button', { name: 'Terminal', exact: true }).count(), 0);
  assert.match(await promptModal.innerText(), /open its thread to reply/);
  assert.deepEqual(errors, []);
});
