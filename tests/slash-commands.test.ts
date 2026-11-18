import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { copyTurns, nativeCopy, nativeLimits, SLASH_COMMANDS, slashCommands, slashKind, slashOf, slashRefusal, slashSuggestions } from '../src/shared/slash-commands.js';

test('the Android app lists the same slash commands', () => {
  const kotlin = readFileSync(new URL('../android/app/src/main/java/ai/factory/droidoffice/core/SlashCommands.kt', import.meta.url), 'utf8');
  const parsed = [...kotlin.matchAll(/Command\("([^"]+)", "([^"]+)", Kind\.(\w+)(?:, listOf\(([^)]*)\))?(, midTurn = true)?\)/g)].map((m) => ({
    name: m[1],
    description: m[2],
    kind: m[3].toLowerCase(),
    aliases: m[4] ? [...m[4].matchAll(/"([^"]+)"/g)].map((a) => a[1]) : [],
    midTurn: !!m[5],
  }));
  assert.deepEqual(
    parsed,
    SLASH_COMMANDS.map((c) => ({ name: c.name, description: c.description, kind: c.kind, aliases: [...(c.aliases ?? [])], midTurn: !!c.midTurn })),
  );
});

test('keeps only native Thread/RPC commands and drops TUI dialogs, /vim and /btw', () => {
  assert.deepEqual(
    SLASH_COMMANDS.map((c) => c.name),
    ['compress', 'clear', 'new', 'handoff', 'copy', 'limits', 'quit'],
  );
  assert.equal(
    SLASH_COMMANDS.some((c) => c.kind === 'tty'),
    false,
  );
  for (const dropped of [
    'model',
    'settings',
    'tree',
    'rewind-conversation',
    'sessions',
    'resume',
    'share',
    'review',
    'missions',
    'workstreams',
    'create-skill',
    'mcp',
    'connectors',
    'plugins',
    'skills',
    'droids',
    'hooks',
    'commands',
    'diagnostics',
    'ide',
    'bug',
    'install-slack-app',
    'setup-incident-response',
    'statusline',
    'themes',
    'language',
    'terminal-setup',
    'cd',
    'cwd',
    'account',
    'billing',
    'login',
    'logout',
    'vim',
    'btw',
    'side',
    'fast',
    'favorite',
    'pin',
    'archive',
    'readiness-report',
    'readiness-fix',
    'install-code-review',
    'status',
    'context',
    'stats',
    'rename',
    'fork',
    'cost',
    'help',
  ]) {
    assert.equal(slashOf(`/${dropped}`)?.command, undefined, `/${dropped} is not offered`);
  }
});

test('reads the command a draft asks for, by name or alias', () => {
  assert.equal(slashOf('hello'), undefined);
  assert.equal(slashOf('/etc/hosts is wrong'), undefined);
  assert.equal(slashRefusal('/etc/hosts is wrong', 'Byte', true), undefined);
  assert.deepEqual(slashOf('  /Compress focus on auth'), { name: 'compress', command: SLASH_COMMANDS.find((c) => c.name === 'compress') });
  assert.equal(slashOf('/compact keep the plan')?.command?.name, 'compress');
  assert.equal(slashOf('/handoff next steps')?.command?.name, 'handoff');
  assert.equal(slashOf('/exit')?.command?.name, 'quit');
  assert.equal(slashOf('/my-skill do it')?.command, undefined);
  assert.equal(slashOf('/my-skill do it')?.name, 'my-skill');
  assert.equal(slashKind('/compact keep the plan'), 'thread');
  assert.equal(slashKind('/copy'), 'thread');
  assert.equal(slashKind('/limits'), 'thread');
  assert.equal(slashKind('/quit'), 'blocked');
  assert.equal(slashKind('/my-skill'), 'thread');
  assert.equal(slashKind('plain text'), 'thread');
});

test('limits opens natively whenever Factory is connected', () => {
  assert.equal(nativeLimits('/limits', true), true);
  assert.equal(nativeLimits('  /LIMITS ', true), true);
  assert.equal(nativeLimits('/limits', false), false);
  assert.equal(slashKind('/limits'), 'thread');
  assert.equal(nativeLimits('/copy', true), false);
  assert.equal(nativeLimits('/limits/file', true), false);
  assert.equal(nativeLimits('show /limits', true), false);
});

test('suggests names that start with what is typed, then aliases, then names containing it', () => {
  assert.deepEqual(
    slashSuggestions('/c').map((c) => c.name),
    ['compress', 'clear', 'copy'],
  );
  assert.deepEqual(
    slashSuggestions('/ex').map((c) => c.name),
    ['quit'],
  );
  assert.deepEqual(
    slashSuggestions('/ff').map((c) => c.name),
    ['handoff'],
  );
  assert.deepEqual(slashSuggestions('/'), SLASH_COMMANDS);
  assert.deepEqual(slashSuggestions('/copy '), []);
  assert.deepEqual(slashSuggestions('copy'), []);
});

test('adds the worker’s skills and custom commands after the built-in ones, never shadowing one', () => {
  const all = slashCommands([
    { name: 'Compact', description: 'A skill named like an alias', source: 'skill' },
    { name: 'handoff', description: 'A skill named like a built-in', source: 'skill' },
    { name: 'review', description: 'Custom command: review', source: 'command' },
    { name: 'security-review', description: 'Security-focused code review', source: 'skill', argumentHint: '[path]' },
    { name: 'review', description: 'Duplicate review skill', source: 'skill' },
    { name: 'odd', description: 'From an unknown place', source: 'plugin' as 'skill' },
  ]);
  assert.deepEqual(all.slice(0, SLASH_COMMANDS.length), [...SLASH_COMMANDS]);
  assert.deepEqual(all.slice(SLASH_COMMANDS.length), [
    { name: 'review', description: 'Custom command: review', kind: 'thread', source: 'command' },
    { name: 'security-review', description: 'Security-focused code review', kind: 'thread', source: 'skill', argumentHint: '[path]' },
  ]);
  assert.deepEqual(slashCommands(), [...SLASH_COMMANDS]);
  assert.deepEqual(slashSuggestions('/', all), all);
  assert.equal(slashOf('/Security-Review the diff', all)?.command?.source, 'skill');
  assert.equal(slashOf('/security-review', SLASH_COMMANDS)?.command, undefined);
  assert.deepEqual(
    slashSuggestions('/rev', all).map((c) => c.name),
    ['review', 'security-review'],
  );
});

test('refuses ending the CLI, and while a turn runs every command not marked midTurn', () => {
  assert.equal(slashRefusal('hello', 'Byte', true), undefined);
  assert.equal(slashRefusal('/new', 'Byte', false), undefined);
  assert.equal(slashRefusal('/my-skill', 'Byte', false), undefined);
  assert.match(slashRefusal('/exit', 'Byte', false) ?? '', /^\/exit would end Byte’s Droid/);
  assert.equal(slashRefusal('/new', 'Byte', true), '/new runs once Byte finishes this turn. Stop it to run it now.');
  assert.match(slashRefusal('/my-skill', 'Byte', true) ?? '', /^\/my-skill runs once Byte finishes/, 'Droid cannot resolve a queued skill');
  for (const draft of ['/copy', '/limits']) assert.equal(slashRefusal(draft, 'Byte', true), undefined, draft);
  for (const draft of ['/compress', '/compact', '/clear', '/new', '/handoff']) assert.ok(slashRefusal(draft, 'Byte', true), draft);
  const custom = slashCommands([{ name: 'deploy', description: 'Ship it', source: 'command' }]);
  assert.ok(slashRefusal('/deploy', 'Byte', true, custom));
});

test('/copy opens the Thread’s copy menu and prefills an optional turn count', () => {
  assert.equal(nativeCopy('/copy'), true);
  assert.equal(nativeCopy('  /COPY  '), true);
  assert.equal(nativeCopy('/copy 3'), true);
  assert.equal(copyTurns('/copy'), '1');
  assert.equal(copyTurns(' /COPY 3 '), '3');
  assert.equal(copyTurns('/copy 12345'), '1234');
  assert.equal(copyTurns('/copy nope'), '1');
  assert.equal(nativeCopy('/copyright'), false);
});
