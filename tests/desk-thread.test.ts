import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import { ORCHESTRATOR_ID } from '../src/shared/mission-control.js';

const status = browserStatus();

test('the desk window mounts Thread-only for Droid workers and Orchestrator, and xterm.js only for shell', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bundle = buildSync({
    stdin: {
      contents:
        "export { openTerminal, openOfficeShell, openTerminalStreams, routeTerminalMessage } from './src/client/ui/terminal'; export { store } from './src/client/state'; export { Terminal } from '@xterm/xterm'; export { ORCHESTRATOR_ID } from './src/shared/mission-control';",
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    bundle: true,
    format: 'iife',
    globalName: 'TerminalUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  await page.route('http://desk.test/', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="modal-root"></div><div id="toasts"></div>' }));
  await page.goto('http://desk.test/');
  await page.setContent('<!doctype html><div id="modal-root"></div><div id="toasts"></div>');
  const css = (await readFile(new URL('../src/client/style.css', import.meta.url), 'utf8')) + (await readFile(new URL('../node_modules/@xterm/xterm/css/xterm.css', import.meta.url), 'utf8'));
  await page.evaluate((content) => {
    const style = document.createElement('style');
    style.textContent = content;
    document.head.append(style);
  }, css);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => ((window as any).__name = (fn: unknown) => fn));
  await page.evaluate(() => {
    const w = window as any;
    const { Terminal, store, openTerminal, routeTerminalMessage } = w.TerminalUI;
    w.termOpens = 0;
    const open = Terminal.prototype.open;
    Terminal.prototype.open = function (host: HTMLElement) {
      w.termOpens++;
      w.term = this;
      open.call(this, host);
    };
    const worker = {
      id: 'pixel',
      name: 'Pixel',
      kind: 'agent',
      deskId: 'desk',
      color: '#89d9ed',
      status: 'idle',
      sessionId: 'session',
      acked: false,
      createdBy: 'owner',
      createdAt: 0,
      cols: 120,
      rows: 40,
      open: false,
    };
    store.workers.set(worker.id, worker);
    w.messages = [];
    w.requests = [];
    w.listeners = new Set<(msg: any) => void>();
    w.net = {
      up: true,
      send(msg: any) {
        w.messages.push(msg);
        if (msg.t === 'thread.read')
          queueMicrotask(() => {
            for (const fn of w.listeners) fn({ t: 'thread.snapshot', workerId: msg.workerId, request: msg.request, sessionId: 'session', entries: [], hasMore: false, presentation: { version: 1, rows: [] } });
          });
        if (msg.t === 'worker.attach' && msg.stream !== false) queueMicrotask(() => routeTerminalMessage({ t: 'term.snapshot', workerId: msg.workerId, data: '', cols: 120, rows: 40, shared: false }));
        return true;
      },
      request: async (msg: any) => {
        w.requests.push(msg);
        return { t: 'action.result', requestId: msg.requestId ?? 'req', ok: true };
      },
      onMessage(fn: any) {
        w.listeners.add(fn);
        return () => w.listeners.delete(fn);
      },
      onStatus() {
        return () => {};
      },
    };
    openTerminal(w.net, worker.id);
  });

  await page.waitForFunction(() => !!document.querySelector('.term-thread-host .worker-thread'));
  assert.equal(await page.locator('.term-thread-host').isVisible(), true);
  assert.equal(await page.locator('.term-host').count(), 0, 'local Droid worker mounts zero xterm host');
  assert.equal(await page.evaluate(() => (window as any).termOpens), 0, 'xterm Terminal.open is never called for Droid workers');
  assert.equal(await page.evaluate(() => (window as any).TerminalUI.openTerminalStreams()), false);
  assert.equal(await page.getByRole('button', { name: /raw tty/i }).count(), 0);
  assert.equal(
    await page.evaluate(() => (window as any).messages.some((msg: any) => msg.t === 'worker.attach' && msg.workerId === 'pixel' && msg.stream === false)),
    true,
    'Thread attaches with stream: false so unread badges clear without streaming PTY bytes',
  );

  // Structured AskUser question card + workspace works directly inside the 3D desk Thread modal.
  await page.evaluate(() => {
    const w = window as any;
    const { store } = w.TerminalUI;
    const current = store.workers.get('pixel');
    store.workers.set('pixel', {
      ...current,
      status: 'needs_input',
      menu: {
        question: 'Ship the daemon switch now?',
        choices: [
          { number: 1, label: 'Yes, ship it' },
          { number: 2, label: 'Run tests first' },
        ],
        freeText: true,
      },
    });
    store.emit('workers');
  });
  await page.locator('.dash-question').waitFor({ state: 'visible' });
  assert.equal(await page.getByText('Answer its question in Raw TTY').count(), 0);
  await page.getByRole('button', { name: 'Answer question' }).click();
  const qw = page.locator('.question-workspace');
  assert.equal(await qw.locator('.qw-question').textContent(), 'Ship the daemon switch now?');
  await qw.locator('input[value="2"]').check();
  await qw.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await page.waitForFunction(() => (window as any).requests.some((msg: any) => msg.t === 'worker.answer'));
  assert.equal(await page.evaluate(() => (window as any).requests.find((msg: any) => msg.t === 'worker.answer').choice), 2);
  await qw.getByRole('button', { name: 'Back to thread' }).click();

  // Orchestrator opens a Thread-only modal and wakes via orchestrator.prompt / stops via orchestrator.interrupt.
  await page.evaluate((orchId) => {
    const w = window as any;
    const { store, openTerminal } = w.TerminalUI;
    w.requests.length = 0;
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
            status: 'exited',
            sessionId: 'orch-session',
            acked: true,
            createdBy: '',
            createdAt: 0,
            cols: 120,
            rows: 40,
            open: false,
          },
          team: [],
        },
        team: [],
      },
      bots: [],
    };
    store.emit('missionControl');
    openTerminal(w.net, orchId);
  }, ORCHESTRATOR_ID);
  await page.waitForFunction(() => document.querySelector('.modal.term h2')?.textContent?.includes('Orchestrator'));
  assert.equal(await page.evaluate(() => (window as any).termOpens), 0);
  assert.equal(await page.evaluate(() => (window as any).TerminalUI.openTerminalStreams()), false);
  await page.locator('.wt-input').fill('Check every floor');
  await page.locator('.wt-input').press('Enter');
  await page.waitForFunction(() => (window as any).requests.some((msg: any) => msg.t === 'orchestrator.prompt'));
  assert.equal(await page.evaluate(() => (window as any).requests.some((msg: any) => msg.t === 'worker.resume')), false);

  await page.evaluate((orchId) => {
    const w = window as any;
    const { store } = w.TerminalUI;
    store.missionControl.orchestrator.agent.worker = { ...store.missionControl.orchestrator.agent.worker, id: orchId, status: 'working' };
    store.emit('missionControl');
  }, ORCHESTRATOR_ID);
  await page.getByRole('button', { name: 'Stop turn' }).click();
  await page.waitForFunction(() => (window as any).requests.some((msg: any) => msg.t === 'orchestrator.interrupt'));

  // Explicit shell worker and boss laptop (openOfficeShell) still mount xterm.js and stream PTY output.
  await page.evaluate(() => {
    const w = window as any;
    const { store, openTerminal } = w.TerminalUI;
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
      cols: 120,
      rows: 40,
      open: false,
    });
    openTerminal(w.net, 'zsh');
  });
  await page.waitForFunction(() => (window as any).termOpens === 1 && !!document.querySelector('.modal.term .term-host'));
  assert.equal(await page.locator('.term-thread-host').count(), 0);
  assert.equal(await page.evaluate(() => (window as any).TerminalUI.openTerminalStreams()), true);

  await page.locator('.modal.term > header > button.close').click();
  await page.evaluate(() => {
    const w = window as any;
    w.TerminalUI.openOfficeShell(w.net);
  });
  await page.waitForFunction(() => (window as any).termOpens === 2);
  assert.deepEqual(errors, []);
});
