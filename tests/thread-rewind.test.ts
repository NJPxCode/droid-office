import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { driveDroidRewind } from '../src/server/worker-rewind.js';
import { WorkerThreadReader } from '../src/server/worker-thread.js';
import { WorkerManager } from '../src/server/workers.js';
import { readRewindMenu, readRewindRestore, rewindProcessing, rewindWithoutFiles, rewound } from '../src/shared/thread-rewind.js';

// Droid 1.12.1, Haiku 5.5 at 120x40, from the approved scratch run. Unrelated transcript rows are
// trimmed, but the menu cells and previews are verbatim.
const MENU = [
  ' ╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮',
  ' │ Select a user message to rewind before                                                                               │',
  ' │                                                                                                                      │',
  ' │ #     Message Preview                                                                                                │',
  ' │ > 12   Reply with just the word: two                                                                                 │',
  ' │   4    Use the Create tool to create notes.txt containing the single line: hello. Then reply wit…                    │',
  ' ╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯',
  '   ↑↓ to navigate   Enter to select   Esc/Q to close   Showing 1-2 of 2',
];
const MENU_OLDER = MENU.map((line) => line.replace('> 12', '  12').replace('  4    Use', '> 4    Use'));
const RESTORE = [
  ' ╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮',
  ' │ Rewind File Restoration                                                                                              │',
  ' │ This rewind point has 1 file change(s) that can be undone:                                                           │',
  ' │   • 1 created file(s) to delete                                                                                      │',
  ' │ > Restore all files                                                                                                  │',
  ' │     Restore 0 file(s), delete 1 created file(s)                                                                      │',
  ' │   Choose files to restore...                                                                                         │',
  ' │     Select which files to restore or delete individually                                                             │',
  " │   Don't restore files                                                                                                │",
  ' │     Rewind conversation only, keep files as they are                                                                 │',
  ' ╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯',
  '   ↑↓ navigate   Enter select   Esc cancel',
];
const RESTORE_CHOOSE = RESTORE.map((line) => line.replace('> Restore all files', '  Restore all files').replace('  Choose files to restore...', '> Choose files to restore...'));
const RESTORE_NONE = RESTORE.map((line) => line.replace('> Restore all files', '  Restore all files').replace("  Don't restore files", "> Don't restore files"));
const REWOUND = [' ●  Rewound conversation to before: "Use the Create tool to create notes.txt containing the single line: hello. Then', '    reply wit…"'];

test('golden rewind menu and file restoration screens', () => {
  assert.deepEqual(readRewindMenu(MENU), {
    rows: [
      { number: 12, preview: 'Reply with just the word: two', selected: true },
      { number: 4, preview: 'Use the Create tool to create notes.txt containing the single line: hello. Then reply wit…', selected: false },
    ],
    empty: false,
    total: 2,
  });
  assert.equal(readRewindMenu(MENU_OLDER)?.rows[1].selected, true);
  assert.deepEqual(readRewindRestore(RESTORE), [
    { label: 'Restore all files', selected: true },
    { label: 'Choose files to restore...', selected: false },
    { label: "Don't restore files", selected: false },
  ]);
  assert.equal(rewound(REWOUND), true);
  assert.equal(rewindProcessing(['Auto (High) (Please wait)']), true);
  assert.equal(rewindWithoutFiles([' │ No file changes found for this rewind point │', ' Press Esc to continue without restoration']), true);
});
test('old completion text cannot bypass restoration or submit its choice more than once', async () => {
  let phase = 'input';
  let restorationPolls = 0;
  let submitted = 0;
  const result = await driveDroidRewind(
    {
      write(data) {
        if (data !== '\r') return;
        if (phase === 'input') phase = 'menu';
        else if (phase === 'menu') phase = 'restore';
        else if (phase === 'restore') submitted++;
      },
      rows: () => {
        if (phase === 'menu') return [...REWOUND, ...MENU_OLDER];
        if (phase === 'restore') {
          if (submitted && ++restorationPolls >= 4) phase = 'done';
          else return [...REWOUND, ...RESTORE_NONE];
        }
        return phase === 'done' ? REWOUND : [];
      },
    },
    { number: 4, preview: 'Use the Create tool to create notes.txt' },
    'conversation',
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(submitted, 1);
});

test('no-files continuation sends one Escape even when its screen persists across polls', async () => {
  let phase = 'input';
  let polls = 0;
  let escapes = 0;
  const result = await driveDroidRewind(
    {
      write(data) {
        if (data === '\r') phase = phase === 'input' ? 'menu' : 'no-files';
        if (data === '\x1b') escapes++;
      },
      rows: () => (phase === 'menu' ? MENU_OLDER : phase === 'no-files' && ++polls < 5 ? [' │ No file changes found for this rewind point │', ' Press Esc to continue without restoration'] : phase === 'no-files' ? REWOUND : []),
    },
    { number: 4, preview: 'Use the Create tool to create notes.txt' },
    'conversation',
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(escapes, 1);
});

test('a preview sharing only its first sixty characters is not the same rewind point', async () => {
  const prefix = 'This deliberately long common prefix belongs to two different conversation forks ';
  const changed = MENU.map((line) => line.replace('Reply with just the word: two', prefix + 'wrong ending'));
  let opened = false;
  let enters = 0;
  const result = await driveDroidRewind(
    {
      write(data) {
        if (data === '/rewind-conversation') opened = true;
        if (data === '\r') enters++;
      },
      rows: () => (opened ? changed : []),
    },
    { number: 12, preview: prefix + 'correct ending' },
    'conversation',
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /conversation changed/);
  assert.equal(enters, 1);
});

test('the driver selects the older message, conversation-only, and clears the prefilled prompt', async () => {
  let screen: string[] = [];
  const writes: string[] = [];
  const io = {
    write(data: string) {
      writes.push(data);
      if (data === '\r' && writes.includes('/rewind-conversation')) {
        if (readRewindMenu(screen) && screen === MENU_OLDER) {
          writes.push('picked');
          screen = RESTORE;
        } else if (readRewindRestore(screen)) {
          screen = REWOUND;
        }
      }
      if (data === '\x1b[B' && readRewindMenu(screen)) screen = MENU_OLDER;
      else if (data === '\x1b[B' && screen === RESTORE) screen = RESTORE_CHOOSE;
      else if (data === '\x1b[B' && screen === RESTORE_CHOOSE) screen = RESTORE_NONE;
    },
    rows: () => screen,
  };
  // Open the menu after the slash command's Enter.
  const open = io.write;
  io.write = (data: string) => {
    open(data);
    if (data === '/rewind-conversation') screen = MENU;
  };
  const result = await driveDroidRewind(io, { number: 4, preview: 'Use the Create tool to create notes.txt' }, 'conversation');
  assert.deepEqual(result, { ok: true });
  assert.ok(writes.includes('/rewind-conversation'));
  assert.ok(writes.includes('\x1b[B'));
  assert.equal(writes.at(-1), '\x15');
});

test('a menu number whose preview belongs to another fork is never selected', async () => {
  let screen: string[] = [];
  const writes: string[] = [];
  const result = await driveDroidRewind(
    {
      write(data) {
        writes.push(data);
        if (data === '/rewind-conversation') screen = MENU;
      },
      rows: () => screen,
    },
    { number: 12, preview: 'A different prompt from another session' },
    'conversation',
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /conversation changed/);
  assert.equal(writes.filter((data) => data === '\r').length, 1, 'only the slash command was submitted');
});

test('a menu that never opens is a clean failure', async () => {
  const writes: string[] = [];
  const result = await driveDroidRewind({ write: (data) => writes.push(data), rows: () => [] }, { number: 4, preview: 'Hello' }, 'files');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /did not open/);
  assert.ok(writes.includes('\x1b'));
});

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
    { type: 'message', id: 'string', seq: 5, timestamp: '2026-11-15T04:00:31.089Z', message: { role: 'user', content: 'String content prompt' } },
    { type: 'message', id: 'legacy', timestamp: '2026-11-15T04:01:31.089Z', message: { role: 'user', content: [{ type: 'text', text: 'Repeat this exact prompt' }] } },
  ];
  await writeFile(path.join(dir, `${source.sessionId}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const reader = new WorkerThreadReader(root);
  // These are the ids the Android Thread actually receives, not ids invented for rewindPoint.
  const users = (await reader.read(source)).entries.filter((entry) => entry.role === 'user' && entry.kind === 'text');
  assert.equal(users.length, 4);
  assert.notEqual(users[0].id, users[1].id);
  assert.deepEqual(await reader.rewindPoint(source, users[0].id), { number: 3, preview: 'Repeat this exact prompt' });
  assert.deepEqual(await reader.rewindPoint(source, users[1].id), { number: 5, preview: 'Repeat this exact prompt' });
  assert.deepEqual(await reader.rewindPoint(source, users[2].id), { number: 6, preview: 'String content prompt' });
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
  const result = await manager.rewind('worker', 'first:0', 'original-session', { number: 3, preview: 'Repeat this exact prompt' }, 'conversation');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /conversation changed/);
  assert.equal(worker.info.sessionId, 'forked-session');
  assert.equal(Reflect.get(worker, 'rewind'), undefined);
  assert.deepEqual(writes, []);
});

test('a rewind point beyond 120 prompts remains reachable in the descending picker', async () => {
  let number = 132;
  let phase = 'input';
  let down = 0;
  let selected: number | undefined;
  const result = await driveDroidRewind(
    {
      write(data) {
        if (data === '\r') {
          if (phase === 'input') phase = 'menu';
          else if (phase === 'menu') {
            selected = number;
            phase = 'restore';
          } else if (phase === 'restore') phase = 'done';
        } else if (data === '\x1b[B' && phase === 'menu') {
          down++;
          number--;
        }
      },
      rows: () =>
        phase === 'menu'
          ? MENU.map((line) =>
              line
                .replace('> 12', `> ${number}`)
                .replace('  4    Use the Create tool to create notes.txt containing the single line: hello. Then reply wit…', `  ${number - 1}    Reply with just the word: two`)
                .replace('Showing 1-2 of 2', 'Showing 1-2 of 132'),
            )
          : phase === 'restore'
            ? RESTORE_NONE
            : phase === 'done'
              ? REWOUND
              : [],
    },
    { number: 1, preview: 'Reply with just the word: two' },
    'conversation',
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(selected, 1, 'select the exact oldest duplicate prompt');
  assert.ok(down > 120);
});

test('a slow fork keeps waiting past five seconds without mistaking a previous completion for success', async () => {
  let phase = 'input';
  let processingSince = 0;
  const started = Date.now();
  const result = await driveDroidRewind(
    {
      write(data) {
        if (data !== '\r') return;
        if (phase === 'input') phase = 'menu';
        else if (phase === 'menu') {
          phase = 'processing';
          processingSince = Date.now();
        }
      },
      rows: () => (phase === 'menu' ? MENU_OLDER : phase === 'processing' && Date.now() - processingSince < 6_000 ? [...REWOUND, 'Auto (High) (Please wait)'] : phase === 'processing' ? REWOUND : []),
    },
    { number: 4, preview: 'Use the Create tool to create notes.txt' },
    'conversation',
  );
  assert.deepEqual(result, { ok: true });
  assert.ok(Date.now() - started >= 6_000);
});
