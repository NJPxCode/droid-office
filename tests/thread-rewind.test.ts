import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { driveDroidRewind } from '../src/server/worker-rewind.js';
import { WorkerThreadReader } from '../src/server/worker-thread.js';
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

test('a menu that never opens is a clean failure', async () => {
  const writes: string[] = [];
  const result = await driveDroidRewind({ write: (data) => writes.push(data), rows: () => [] }, { number: 4, preview: 'Hello' }, 'files');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /did not open/);
  assert.ok(writes.includes('\x1b'));
});

test('a rewind point comes from the user message seq, not its projected entry index', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'office-rewind-point-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  const source = { sessionId: 'session-one', cwd };
  const dir = path.join(root, cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
  await mkdir(dir, { recursive: true });
  const rows = [
    { type: 'session_start', id: source.sessionId, cwd },
    { type: 'message', id: 'hook', seq: 0, message: { role: 'user', content: [], visibility: 'user_only', hookEventName: 'SessionStart' } },
    { type: 'message', id: 'context-abc', seq: 1, message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>hidden</system-reminder>' }], visibility: 'llm_only' } },
    { type: 'message', id: 'abc', seq: 2, timestamp: '2026-11-15T03:58:31.089Z', message: { role: 'user', content: [{ type: 'text', text: 'Use the Create tool to create notes.txt' }] } },
    { type: 'message', id: 'def', seq: 3, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ];
  await writeFile(path.join(dir, `${source.sessionId}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const reader = new WorkerThreadReader(root);
  assert.deepEqual(await reader.rewindPoint(source, 'abc:0'), { number: 3, preview: 'Use the Create tool to create notes.txt' });
  assert.equal(await reader.rewindPoint(source, 'abc:text'), undefined, 'an array message uses its text part index');
  assert.equal(await reader.rewindPoint(source, 'def:text'), undefined);
  assert.equal(await reader.rewindPoint(source, 'missing:text'), undefined);
});
