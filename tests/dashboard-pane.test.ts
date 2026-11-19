import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { modeFor } from '../src/client/dashboard-pane.js';
import { ORCHESTRATOR_ID } from '../src/shared/mission-control.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import { FIXTURE } from '../tools/thread-fixture.mjs';

const status = browserStatus();

test('modeFor routes all Droid sessions to thread and shell to terminal or info', () => {
  const base: WorkerInfo = {
    id: 'pixel',
    name: 'Pixel',
    kind: 'agent',
    deskId: 'desk-1',
    color: '#89d9ed',
    status: 'idle',
    acked: true,
    createdBy: 'owner',
    createdAt: 0,
    cols: 120,
    rows: 40,
    open: false,
  };
  assert.equal(modeFor(undefined), 'empty');
  for (const s of ['starting', 'idle', 'working', 'needs_input', 'done', 'exited', 'offline'] as const) {
    assert.equal(modeFor({ ...base, status: s }), 'thread');
    assert.equal(modeFor({ ...base, id: ORCHESTRATOR_ID, status: s }), 'thread');
    assert.equal(modeFor({ ...base, kind: 'cloud', status: s, cloud: { computerId: 'c1', computerName: 'mac-mini', autonomy: 'high' } }), 'thread');
  }
  assert.equal(modeFor({ ...base, remote: { by: 'tailnet' } }), 'info');
  assert.equal(modeFor({ ...base, kind: 'shell', status: 'idle' }), 'terminal');
  assert.equal(modeFor({ ...base, kind: 'shell', status: 'working' }), 'terminal');
  assert.equal(modeFor({ ...base, kind: 'shell', status: 'exited' }), 'info');
  assert.equal(modeFor({ ...base, kind: 'shell', status: 'offline' }), 'info');
});

test('empty pane clicks hire in place without swallowing worker picks or allowing offline hires', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bundle = buildSync({ entryPoints: [fileURLToPath(new URL('../src/client/dashboard-pane.ts', import.meta.url))], bundle: true, format: 'iife', globalName: 'PaneUI', write: false, target: 'es2022' }).outputFiles[0].text;
  await page.setContent('<!doctype html><div id="modal-root"></div>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const w = window as any;
    w.hires = [];
    w.assignments = [];
    w.live = true;
    const pane = w.PaneUI.createPane(
      {
        live() {
          return w.live;
        },
        focus() {},
        mission() {
          return undefined;
        },
        worker() {
          return undefined;
        },
        hire(index: number) {
          w.hires.push(index);
        },
        assign(index: number, id: string) {
          w.assignments.push([index, id]);
        },
      },
      3,
    );
    document.body.append(pane.el);
    w.paint = (anyone = true) =>
      pane.update({
        focused: true,
        maximized: false,
        canMaximize: false,
        covered: false,
        takeFocus: false,
        anyone,
        candidates: anyone ? [{ id: 'pixel', name: 'Pixel', color: '#89d9ed' }] : [],
      });
    w.paint();
  });
  await page.locator('.dash-pick span').last().click();
  assert.deepEqual(await page.evaluate(() => (window as any).assignments), [[3, 'pixel']]);
  assert.deepEqual(await page.evaluate(() => (window as any).hires), []);
  await page.getByRole('button', { name: 'Hire Droid here' }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).hires), [3], 'button bubbling does not hire twice');
  await page.locator('.dash-empty h3').click();
  await page.locator('.dash-empty').dispatchEvent('click');
  assert.deepEqual(await page.evaluate(() => (window as any).hires), [3, 3, 3]);
  await page.evaluate(() => {
    document.querySelector('.dash-empty h3')!.firstChild!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  assert.deepEqual(errors, [], 'non-element event targets do not throw');
  await page.evaluate(() => {
    (window as any).live = false;
    (window as any).paint();
  });
  assert.equal(await page.getByRole('button', { name: 'Hire Droid here' }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Pixel' }).isDisabled(), true);
  await page.locator('.dash-empty h3').click();
  assert.deepEqual(await page.evaluate(() => (window as any).hires), [3, 3, 3], 'offline backgrounds do not hire');
  await page.evaluate(() => {
    (window as any).live = true;
    (window as any).paint(false);
  });
  await page.getByRole('button', { name: 'Hire Droid here' }).focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => (window as any).hires), [3, 3, 3, 3], 'an unpopulated floor supports keyboard hiring');
});

test('only the focused thread pane shows its composer, reclaiming space without losing drafts or reading position', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bundle = buildSync({
    stdin: {
      contents: "export { createPane } from './dashboard-pane'; export { store } from './state'; export { reconcilePanes } from './dashboard-workspace';",
      resolveDir: fileURLToPath(new URL('../src/client', import.meta.url)),
    },
    bundle: true,
    format: 'iife',
    globalName: 'PaneUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  const captured = JSON.parse(readFileSync(FIXTURE, 'utf8')).cases.find((example: { name: string }) => example.name === 'reported_release_turn');
  await page.setContent('<!doctype html><div id="dashboard"><div class="dash-workspace"></div></div>');
  await page.addStyleTag({ content: readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8') });
  await page.addStyleTag({
    content:
      '.dash-workspace { position: relative; flex: none; height: 360px; width: 100%; } .dash-pane { top: 0; width: 49%; height: 100%; transition: none; animation: none; } .dash-pane:first-child { left: 0; } .dash-pane:last-child { left: 51%; }',
  });
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.evaluate((captured) => {
    const w = window as any;
    w.workers = ['Pixel', 'Byte'].map((name) => ({ id: name.toLowerCase(), name, color: '#89d9ed', kind: 'agent', status: 'idle', sessionId: 'captured', acked: true }));
    for (const worker of w.workers) w.PaneUI.store.workers.set(worker.id, worker);
    const listeners = new Set<(msg: any) => void>();
    w.actions = [];
    w.focused = 0;
    const net = {
      send(msg: any) {
        if (msg.t === 'thread.read')
          queueMicrotask(() => {
            for (const receive of listeners)
              receive({ t: 'thread.snapshot', workerId: msg.workerId, request: msg.request, sessionId: 'captured', entries: captured.entries, hasMore: false, presentation: { version: 1, rows: captured.expected } });
          });
        return true;
      },
      onMessage(receive: (msg: any) => void) {
        listeners.add(receive);
        return () => listeners.delete(receive);
      },
    };
    w.paint = () =>
      w.panes.forEach((pane: any, index: number) => pane.update({ worker: w.workers[index], focused: index === w.focused, maximized: false, canMaximize: false, covered: false, candidates: [], anyone: true, takeFocus: false }));
    const host = {
      net,
      live: () => true,
      floor: () => 'floor',
      busy: () => false,
      read: () => '',
      remember() {},
      action: async (msg: any) => {
        w.actions.push(msg);
      },
      mission: () => undefined,
      worker: (id: string) => w.workers.find((m: any) => m.id === id),
      focus(index: number) {
        if (w.focused === index) return;
        w.focused = index;
        w.paint();
      },
    };
    w.panes = [0, 1].map((index) => w.PaneUI.createPane(host, index));
    document.querySelector('.dash-workspace')!.append(...w.panes.map((pane: any) => pane.el));
    w.paint();
  }, captured);
  const panes = page.locator('.dash-pane');
  const first = panes.nth(0);
  const second = panes.nth(1);
  await first.locator('.wt-entry').first().waitFor();
  assert.equal(await page.locator('.dash-pane-views, .dash-pane-flip').count(), 0, 'no Thread/TTY switcher or flip button');
  await first.locator('.wt-list').evaluate((el) => {
    for (const details of el.querySelectorAll('details')) details.open = true;
    for (const trigger of el.querySelectorAll<HTMLButtonElement>('.wt-sg-trigger, .wt-tr-trigger')) if (trigger.hasAttribute('aria-expanded')) trigger.click();
  });
  await first.locator('.wt-scroll').evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await first.locator('.wt-latest').waitFor({ state: 'visible' });
  await first.locator('.wt-latest').click();
  assert.equal(await first.locator('.wt-composer').isVisible(), true);
  assert.equal(await second.locator('.wt-composer').isVisible(), false);
  const height = () => first.locator('.wt-scroll').evaluate((el) => el.clientHeight);
  const bottomGap = () => first.locator('.wt-scroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  const smallHeight = await height();
  const composerHeight = await first.locator('.wt-composer').evaluate((el) => el.getBoundingClientRect().height);
  assert.equal(await page.getByRole('textbox', { name: 'Message to Pixel' }).count(), 1, 'the composer names its worker');
  await first.locator('.wt-input').fill('Keep this unsent draft');
  await first.locator('.wt-input').evaluate((el) => ((window as any).originalInput = el));
  await second.locator('.dash-pane-head').click();
  assert.equal(await second.locator('.wt-input').evaluate((el) => document.activeElement === el), true, 'clicking another pane focuses its composer');
  await page.keyboard.type('Ready to type');
  assert.equal(await second.locator('.wt-input').inputValue(), 'Ready to type', 'typing after one click goes into the selected pane');
  assert.equal(await first.locator('.wt-input').inputValue(), 'Keep this unsent draft');
  await page.waitForFunction(() => {
    const el = document.querySelector('.wt-scroll')!;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
  });
  assert.equal(await first.locator('.wt-composer').isVisible(), false);
  assert.equal(await second.locator('.wt-composer').isVisible(), true);
  assert.ok(Math.abs((await height()) - smallHeight - composerHeight) < 2, 'the entire composer height becomes conversation space');
  assert.ok((await bottomGap()) < 2, 'following latest stays pinned when the composer collapses');
  await first.locator('.wt-scroll').focus();
  assert.equal(await first.locator('.wt-input').isVisible(), true);
  assert.equal(await first.locator('.wt-scroll').evaluate((el) => document.activeElement === el), true);
  assert.equal(await first.locator('.wt-input').inputValue(), 'Keep this unsent draft');
  assert.equal(await first.locator('.wt-input').evaluate((el) => (window as any).originalInput === el), true);
  await page.waitForFunction(() => {
    const el = document.querySelector('.wt-scroll')!;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  // The owner scrolls up (a scroll with no wheel, touch or key behind it is the Thread's own).
  await first.locator('.wt-scroll').evaluate((el) => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }));
    el.scrollTop = 40;
    el.dispatchEvent(new Event('scroll'));
  });
  const top = await first.locator('.wt-scroll').evaluate((el) => el.scrollTop);
  assert.ok(top > 0 && (await bottomGap()) > 80, 'the captured conversation overflows the pane');
  await second.locator('.dash-pane-head').click();
  await first.locator('.wt-scroll').focus();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await first.locator('.wt-scroll').evaluate((el) => el.scrollTop), top);
  await second.locator('.dash-pane-head').click();
  await first.locator('.wt-input').evaluate((el: HTMLTextAreaElement) => el.focus());
  assert.equal(await first.locator('.wt-input').evaluate((el) => document.activeElement === el), false);
  assert.equal(await second.locator('.wt-composer').isVisible(), true);
  await page.evaluate(() => {
    const w = window as any;
    w.workers[0].status = 'needs_input';
    w.paint();
  });
  assert.equal(await first.locator('.dash-question').isVisible(), true);
  await first.locator('.wt-scroll').focus();
  assert.equal(await first.locator('.wt-composer').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => (window as any).actions), [], 'selecting a pane never sends a prompt');
  await page.evaluate(() => {
    const w = window as any;
    w.workers[0].status = 'idle';
    w.workers.reverse();
    w.PaneUI.reconcilePanes(
      w.panes,
      w.workers.map((worker: any) => worker.id),
    );
    w.focused = 0;
    w.paint();
  });
  assert.equal(await first.getAttribute('aria-label'), 'Pane 2: Pixel');
  assert.equal(await first.locator('.dash-pane-no').textContent(), '2');
  assert.equal(await first.locator('.wt-input').evaluate((el) => (window as any).originalInput === el), true, 'moving retains the mounted Thread and its draft resources');
  await first.locator('.dash-pane-head').click();
  assert.equal(await page.evaluate(() => (window as any).focused), 1, 'moved pane actions use their new slot');
  assert.equal(await first.locator('.wt-input').inputValue(), 'Keep this unsent draft');
  assert.equal(await first.locator('.wt-composer').isVisible(), true);
  assert.equal(await first.locator('.wt-input').evaluate((el) => document.activeElement === el), true, 'moved panes still focus their own composer');
  await second.locator('.dash-pane-head').click();
  const summary = first.locator('.wt-list :is(.wt-sg-trigger, .wt-tr-trigger)[aria-expanded], .wt-list summary').first();
  // The owner scrolls up to it first, so the Thread stops following the bottom.
  const scrollBox = await first.locator('.wt-scroll').boundingBox();
  await page.mouse.move(scrollBox!.x + scrollBox!.width / 2, scrollBox!.y + scrollBox!.height / 2);
  await page.mouse.wheel(0, -1000);
  await page.waitForFunction(() => document.querySelector('.wt-scroll')!.scrollTop === 0);
  await summary.click();
  assert.equal(await summary.evaluate((el) => document.activeElement === el), true, 'clicking a disclosure keeps keyboard focus on that control');
  await second.locator('.dash-pane-head').click();
  await first
    .locator('.wt-entry')
    .first()
    .evaluate((el) => {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      const selection = window.getSelection()!;
      selection.selectAllChildren(el);
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  assert.equal(await first.locator('.wt-input').evaluate((el) => document.activeElement === el), false, 'selecting conversation text does not jump into the composer');
  assert.ok(await page.evaluate(() => window.getSelection()!.toString().length > 0));
  await page.evaluate(() => {
    window.getSelection()!.removeAllRanges();
    (window as any).panes[1].focusContent();
  });
  assert.equal(await first.locator('.wt-input').evaluate((el) => document.activeElement === el), true, 'explicit keyboard pane focus prefers the composer over earlier history');
  await page.evaluate(() => (window as any).panes.forEach((pane: any) => pane.dispose()));
  assert.deepEqual(errors, []);
});

test('a pane keeps one answer window open across a structured questionnaire and closes it when the worker moves on', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser, { viewport: { width: 1280, height: 860 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bundle = buildSync({
    stdin: { contents: "export { createPane } from './dashboard-pane'; export { store } from './state';", resolveDir: fileURLToPath(new URL('../src/client', import.meta.url)) },
    bundle: true,
    format: 'iife',
    globalName: 'PaneUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  const captured = JSON.parse(readFileSync(FIXTURE, 'utf8')).cases.find((example: { name: string }) => example.name === 'reported_release_turn');
  const menus = {
    first: {
      question: 'Which hypervisor should we use?',
      choices: [
        { number: 1, label: 'UTM' },
        { number: 2, label: 'Parallels' },
      ],
      freeText: true,
    },
    second: {
      question: 'Which Windows licence should we use?',
      choices: [
        { number: 1, label: 'Evaluation' },
        { number: 2, label: 'Retail' },
      ],
      freeText: true,
    },
    third: {
      question: 'How should agents connect?',
      choices: [
        { number: 1, label: 'SSH' },
        { number: 2, label: 'RDP' },
      ],
      freeText: true,
    },
  };
  await page.setContent('<!doctype html><div id="dashboard"><div class="dash-workspace"></div></div><div id="modal-root"></div>');
  await page.addStyleTag({ content: readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8') });
  await page.addStyleTag({ content: '.dash-workspace { position: relative; height: 700px; } .dash-pane { top: 0; left: 0; width: 100%; height: 100%; transition: none; animation: none; }' });
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.evaluate(
    ({ captured, menus }) => {
      const w = window as any;
      w.menus = menus;
      w.worker = {
        id: 'pixel',
        name: 'Pixel',
        color: '#89d9ed',
        kind: 'agent',
        status: 'needs_input',
        sessionId: 'captured',
        acked: true,
        ask: {
          kind: 'question',
          questions: [
            { question: 'Which hypervisor should we use?', topic: 'Hypervisor', options: ['UTM', 'Parallels'], multiSelect: false },
            { question: 'Which Windows licence should we use?', topic: 'Windows-licence', options: ['Evaluation', 'Retail'], multiSelect: false },
            { question: 'How should agents connect?', topic: 'Agent-access', options: ['SSH', 'RDP'], multiSelect: false },
          ],
        },
        menu: menus.first,
      };
      w.PaneUI.store.workers.set('pixel', w.worker);
      w.show = (name: string | undefined) => {
        w.worker = { ...w.worker, menu: name ? w.menus[name] : undefined };
        w.PaneUI.store.workers.set('pixel', w.worker);
        w.pane.paintQuestion();
      };
      w.actions = [];
      const listeners = new Set<(msg: any) => void>();
      const net = {
        send(msg: any) {
          if (msg.t === 'thread.read')
            queueMicrotask(() => {
              for (const receive of listeners)
                receive({ t: 'thread.snapshot', workerId: msg.workerId, request: msg.request, sessionId: 'captured', entries: captured.entries, hasMore: false, presentation: { version: 1, rows: captured.expected } });
            });
          return true;
        },
        onMessage(receive: (msg: any) => void) {
          listeners.add(receive);
          return () => listeners.delete(receive);
        },
      };
      w.pane = w.PaneUI.createPane(
        {
          net,
          live: () => true,
          floor: () => 'floor',
          busy: () => false,
          usable: () => true,
          read: () => '',
          remember() {},
          action: async (msg: any) => {
            w.actions.push(msg);
          },
          mission: () => undefined,
          worker: (id: string) => (id === 'pixel' ? w.worker : undefined),
          focus() {},
        },
        0,
      );
      document.querySelector('.dash-workspace')!.append(w.pane.el);
      w.paint = () => w.pane.update({ worker: w.worker, focused: true, maximized: false, canMaximize: false, covered: false, candidates: [], anyone: true, takeFocus: false });
      w.paint();
    },
    { captured, menus },
  );
  const workspace = page.locator('.question-workspace');
  const question = () => workspace.locator('.qw-question').textContent();
  const states = () => workspace.locator('.qw-step').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-state')));
  const show = (name?: string) => page.evaluate((name) => (window as any).show(name), name);
  await page.getByRole('button', { name: 'Answer questions' }).click();
  assert.equal(await question(), 'Which hypervisor should we use?');
  assert.deepEqual(await states(), ['current', 'upcoming', 'upcoming']);
  assert.equal(await workspace.getByRole('button', { name: /raw tty/i }).count(), 0);

  // Answered elsewhere before the owner started: the window follows to the next question.
  await show('second');
  assert.equal(await question(), 'Which Windows licence should we use?');
  assert.deepEqual(await states(), ['done', 'current', 'upcoming']);
  assert.equal(await workspace.getByRole('button', { name: 'Show current question' }).isVisible(), false);

  // A started draft is never swapped for another question without the owner's say.
  await workspace.locator('input[value="2"]').check();
  await show('third');
  assert.equal(await question(), 'Which Windows licence should we use?');
  assert.match((await workspace.locator('.qw-feedback').textContent()) ?? '', /changed or was answered elsewhere/);
  await workspace.getByRole('button', { name: 'Show current question' }).click();
  assert.equal(await question(), 'How should agents connect?');
  assert.equal(await workspace.locator('input[value="2"]').isChecked(), false, 'the earlier draft does not carry over');

  await workspace.locator('input[value="1"]').check();
  await workspace.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await page.waitForFunction(() => (window as any).actions.length === 1);
  const sent = await page.evaluate(() => (window as any).actions[0]);
  assert.equal(sent.t, 'worker.answer');
  assert.equal(sent.choice, 1);
  assert.equal(sent.menu.question, 'How should agents connect?');
  await page.waitForFunction(() => document.querySelector('.qw-feedback')?.textContent === 'Sent. Pixel is continuing.');
  assert.equal(await workspace.locator('.qw-step').nth(0).locator('.qw-step-answer').textContent(), 'Answered');
  assert.equal(await workspace.count(), 1, 'one window served the whole questionnaire');

  // The worker moves on: the window says so, then closes by itself.
  await page.evaluate(() => {
    const w = window as any;
    w.worker = { ...w.worker, status: 'working', ask: undefined, menu: undefined };
    w.PaneUI.store.workers.set('pixel', w.worker);
    w.paint();
  });
  await workspace.waitFor({ state: 'detached', timeout: 6000 });

  // A cloud worker's AskUser uses cloud.menu identically, with no Review step and no Raw TTY button.
  await page.evaluate(() => {
    const w = window as any;
    w.actions.length = 0;
    w.worker = {
      ...w.worker,
      kind: 'cloud',
      status: 'needs_input',
      ask: {
        kind: 'question',
        questions: [
          { question: 'How should a multi-question series flow inside the single overlay?', topic: 'Series flow', options: ['Guided stepper (Recommended)', 'Fill all, then send'], multiSelect: false },
          { question: 'For single-choice questions, should picking an option send it right away?', topic: 'Single pick', options: ['Keep explicit submit', 'Pick sends immediately'], multiSelect: false },
        ],
      },
      cloud: {
        computerId: 'computer',
        computerName: 'mac-mini',
        menu: {
          question: 'How should a multi-question series flow inside the single overlay?',
          choices: [
            { number: 1, label: 'Guided stepper (Recommended)' },
            { number: 2, label: 'Fill all, then send' },
          ],
          freeText: true,
        },
      },
    };
    w.PaneUI.store.workers.set('pixel', w.worker);
    w.paint();
  });
  await page.getByRole('button', { name: 'Answer questions' }).click();
  assert.deepEqual(await states(), ['current', 'upcoming']);
  assert.equal(await workspace.getByRole('button', { name: /raw tty/i }).count(), 0);
  await workspace.locator('input[value="1"]').check();
  await workspace.getByRole('button', { name: 'Submit and continue' }).click();
  await page.waitForFunction(() => document.querySelector('.qw-feedback')?.textContent === 'Answer sent. Opening question 2 of 2…');
  await page.evaluate(() => {
    const w = window as any;
    w.worker = {
      ...w.worker,
      cloud: {
        ...w.worker.cloud,
        menu: {
          question: 'For single-choice questions, should picking an option send it right away?',
          choices: [
            { number: 1, label: 'Keep explicit submit' },
            { number: 2, label: 'Pick sends immediately' },
          ],
          freeText: true,
        },
      },
    };
    w.PaneUI.store.workers.set('pixel', w.worker);
    w.pane.paintQuestion();
  });
  assert.deepEqual(await states(), ['done', 'current']);
  assert.equal(await workspace.locator('.qw-step').first().locator('.qw-step-answer').textContent(), 'Guided stepper (Recommended)');
  await workspace.locator('input[value="1"]').check();
  await workspace.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.qw-feedback')?.textContent === 'Sent. Pixel is continuing.');
  await page.evaluate(() => {
    const w = window as any;
    w.worker = { ...w.worker, status: 'working', ask: undefined, cloud: { ...w.worker.cloud, menu: undefined } };
    w.PaneUI.store.workers.set('pixel', w.worker);
    w.paint();
  });
  await workspace.waitFor({ state: 'detached', timeout: 6000 });
  assert.deepEqual(errors, []);
});
