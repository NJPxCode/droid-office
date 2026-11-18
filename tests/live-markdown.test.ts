import assert from 'node:assert/strict';
import { test } from 'node:test';
import { marked } from 'marked';
import { settledMarkdownEnd } from '../src/shared/live-markdown.js';

const render = (src: string) => marked.parse(src, { async: false }) as string;

test('settledMarkdownEnd splits before the last fresh block after a blank line', () => {
  const text = 'First paragraph.\n\nSecond paragraph\nstill going';
  assert.equal(settledMarkdownEnd(text), 'First paragraph.\n\n'.length);
  assert.equal(settledMarkdownEnd('One line only'), 0);
  assert.equal(settledMarkdownEnd('No blank\nyet\n'), 0);
});

test('settledMarkdownEnd counts a line still arriving only once its start rules out a list, quote or table', () => {
  assert.equal(settledMarkdownEnd('A\n\nB'), 3);
  assert.equal(settledMarkdownEnd('A\n\nB\n'), 3);
  assert.equal(settledMarkdownEnd('A\n\n'), 0);
  for (const partial of ['1', '-', '>', '|', ' ', '*', '```', '$']) assert.equal(settledMarkdownEnd(`- item\n\n${partial}`), 0, partial);
  assert.equal(settledMarkdownEnd('```\na\n\nb'), 0);
});

test('settledMarkdownEnd never splits inside a code fence, list, quote or table', () => {
  assert.equal(settledMarkdownEnd('```js\nconst a = 1;\n\nconst b = 2;\n'), 0);
  assert.equal(settledMarkdownEnd('Intro\n\n```js\na\n\nb\n```\n\nAfter\n'), 'Intro\n\n```js\na\n\nb\n```\n\n'.length);
  assert.equal(settledMarkdownEnd('Intro\n\n- one\n\n- two\n'), 0);
  assert.equal(settledMarkdownEnd('Intro\n\n1. one\n\n2. two\n\n   more\n'), 0);
  assert.equal(settledMarkdownEnd('Intro\n\n> quote\n\n> more\n'), 0);
  assert.equal(settledMarkdownEnd('Intro\n\n| a | b |\n| - | - |\n\n| c | d |\n'), 0);
  assert.equal(settledMarkdownEnd('- one\n\n- two\n\nAfter\n'), '- one\n\n- two\n\n'.length);
});

test('rendering the settled part and the rest apart matches rendering the whole reply', () => {
  const reply = [
    '# Plan',
    '',
    'Some **bold** text that wraps',
    'onto a second line.',
    '',
    '- item one',
    '',
    '  continued item',
    '- item two',
    '',
    '```ts',
    'const x = 1;',
    '',
    'const y = 2;',
    '```',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '> quoted',
    '',
    'Done.',
    '',
  ].join('\n');
  for (let i = 1; i <= reply.length; i++) {
    const text = reply.slice(0, i);
    const end = settledMarkdownEnd(text);
    assert.equal(render(text.slice(0, end)) + render(text.slice(end)), render(text), `split at ${end} of ${JSON.stringify(text)}`);
  }
});
