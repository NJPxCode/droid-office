import test from 'node:test';
import assert from 'node:assert/strict';
import { THREAD_VIEW_DEFAULTS, isDefaultThreadViewPrefs, normalizeThreadViewPrefs, threadViewRowKey, threadViewVars } from '../src/client/ui/thread-view-prefs.js';

test('nothing saved, or something that is not an object, is the defaults', () => {
  for (const raw of [undefined, null, 'md', 7, [], [{ textSize: 'xl' }]]) {
    assert.deepEqual(normalizeThreadViewPrefs(raw), THREAD_VIEW_DEFAULTS);
  }
  assert.deepEqual(THREAD_VIEW_DEFAULTS, { textSize: 'md', font: 'sans', spacing: 'default', width: 'default', work: 'steps', tools: 'folded', thinking: 'folded' });
});

test('a partial save keeps what it names and defaults the rest', () => {
  assert.deepEqual(normalizeThreadViewPrefs({ textSize: 'lg', thinking: 'hidden' }), { ...THREAD_VIEW_DEFAULTS, textSize: 'lg', thinking: 'hidden' });
});

test('values that are unknown, mistyped or for another setting fall back to their default', () => {
  const prefs = normalizeThreadViewPrefs({ textSize: 'huge', font: 'serif', spacing: 3, width: 'wide', work: 'fold', tools: 'hidden', thinking: null, extra: 'x' });
  assert.deepEqual(prefs, { textSize: 'md', font: 'serif', spacing: 'default', width: 'wide', work: 'fold', tools: 'folded', thinking: 'folded' });
  assert.equal('extra' in prefs, false);
});

test('every option of every setting is accepted as it is', () => {
  for (const textSize of ['sm', 'md', 'lg', 'xl'] as const) assert.equal(normalizeThreadViewPrefs({ textSize }).textSize, textSize);
  for (const font of ['sans', 'serif', 'mono'] as const) assert.equal(normalizeThreadViewPrefs({ font }).font, font);
  for (const spacing of ['compact', 'default', 'relaxed'] as const) assert.equal(normalizeThreadViewPrefs({ spacing }).spacing, spacing);
  for (const width of ['narrow', 'default', 'wide', 'full'] as const) assert.equal(normalizeThreadViewPrefs({ width }).width, width);
  for (const work of ['steps', 'fold'] as const) assert.equal(normalizeThreadViewPrefs({ work }).work, work);
  for (const tools of ['folded', 'open'] as const) assert.equal(normalizeThreadViewPrefs({ tools }).tools, tools);
  for (const thinking of ['hidden', 'folded', 'open'] as const) assert.equal(normalizeThreadViewPrefs({ thinking }).thinking, thinking);
});

test('the result is a fresh object, so a caller cannot change the defaults', () => {
  const prefs = normalizeThreadViewPrefs({});
  assert.notEqual(prefs, THREAD_VIEW_DEFAULTS);
  prefs.textSize = 'xl';
  assert.equal(THREAD_VIEW_DEFAULTS.textSize, 'md');
  assert.equal(isDefaultThreadViewPrefs(normalizeThreadViewPrefs({})), true);
  assert.equal(isDefaultThreadViewPrefs(prefs), false);
});

test('the defaults draw the Thread as it was drawn before the settings existed', () => {
  assert.deepEqual(threadViewVars(THREAD_VIEW_DEFAULTS), {
    '--wt-text-scale': '1',
    '--wt-prose-font': 'var(--font-sans)',
    '--wt-entry-gap': 'var(--space-5)',
    '--wt-prose-leading': '1.725',
    '--wt-measure': '768px',
  });
});

test('each choice sets its CSS variable', () => {
  const vars = threadViewVars(normalizeThreadViewPrefs({ textSize: 'xl', font: 'mono', spacing: 'relaxed', width: 'narrow' }));
  assert.equal(vars['--wt-text-scale'], '1.29');
  assert.equal(vars['--wt-prose-font'], 'var(--font-mono)');
  assert.equal(vars['--wt-entry-gap'], 'var(--space-7)');
  assert.equal(vars['--wt-prose-leading'], '1.9');
  assert.equal(vars['--wt-measure'], '640px');
  assert.match(threadViewVars(normalizeThreadViewPrefs({ font: 'serif' }))['--wt-prose-font'], /Georgia/);
  assert.equal(threadViewVars(normalizeThreadViewPrefs({ spacing: 'compact' }))['--wt-prose-leading'], '1.55');
});

test('only the choices that change how a row is built change its paint key', () => {
  const base = threadViewRowKey(THREAD_VIEW_DEFAULTS);
  for (const patch of [{ textSize: 'xl' }, { font: 'serif' }, { spacing: 'compact' }, { width: 'full' }]) {
    assert.equal(threadViewRowKey(normalizeThreadViewPrefs(patch)), base);
  }
  const keys = [{ work: 'fold' }, { tools: 'open' }, { thinking: 'hidden' }, { thinking: 'open' }].map((patch) => threadViewRowKey(normalizeThreadViewPrefs(patch)));
  assert.equal(new Set([base, ...keys]).size, 5);
});
