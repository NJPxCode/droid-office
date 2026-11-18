import assert from 'node:assert/strict';
import test from 'node:test';
import { REVEAL_END_MS, REVEAL_MAX_LAG_MS, REVEAL_PARTIAL_MS, StreamReveal } from '../src/shared/stream-reveal.js';

const reply = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
const FRAME = 16.7;

/** Frames of revealing `arrivals` ([ms, length] pairs), as [ms, shown] per frame. */
function play(arrivals: [number, number][], ms: number, ended?: number) {
  const reveal = new StreamReveal();
  const out: [number, number][] = [];
  let text = '';
  let next = 0;
  for (let t = 0; t <= ms; t += FRAME) {
    while (next < arrivals.length && arrivals[next][0] <= t) text = reply.slice(0, arrivals[next++][1]);
    out.push([t, reveal.advance('text:1', text, FRAME, { ended: ended !== undefined && t >= ended })]);
  }
  return out;
}

const wholeWords = (shown: number, end: number) => shown === 0 || shown === end || reply[shown - 1] === ' ';

test('steady deltas show word by word at their own pace, a little behind', () => {
  const arrivals: [number, number][] = [];
  for (let t = 0, n = 0; n < 1500; t += 40) arrivals.push([t, (n += 12)]);
  const frames = play(arrivals, arrivals.at(-1)![0] + 1500);
  const steps = frames.slice(1).map(([, n], i) => n - frames[i][1]);
  assert.ok(
    frames.every(([, n]) => wholeWords(n, arrivals.at(-1)![1])),
    'only whole words show',
  );
  assert.ok(Math.max(...steps) <= 20, `at most a few words a frame (${Math.max(...steps)})`);
  const growing = frames.filter(([t]) => t > 400 && t < arrivals.at(-1)![0]);
  const idle = growing.filter(([, n], i) => i > 0 && n === growing[i - 1][1]).length;
  assert.ok(idle / growing.length < 0.5, 'text shows on most frames while it streams');
  const last = arrivals.at(-1)!;
  const caught = frames.find(([t, n]) => t >= last[0] && n === last[1]);
  assert.ok(caught && caught[0] - last[0] <= 500, 'caught up soon after the last delta');
});

test('a burst rolls out over a fraction of a second instead of landing at once', () => {
  const frames = play([[0, 1200]], 2000);
  const steps = frames.slice(1).map(([, n], i) => n - frames[i][1]);
  assert.ok(Math.max(...steps) <= 40, `no frame shows more than a few words (${Math.max(...steps)})`);
  const done = frames.find(([, n]) => n === 1200);
  // Its last word may wait for the rest of it a moment longer.
  assert.ok(done && done[0] <= REVEAL_MAX_LAG_MS + REVEAL_PARTIAL_MS + 2 * FRAME, `the burst shows within ${REVEAL_MAX_LAG_MS} ms (${done?.[0]})`);
});

test('spaced-out pieces spread across the gap between them', () => {
  const arrivals: [number, number][] = [];
  for (let t = 0, n = 0; n < 800; t += 500) arrivals.push([t, (n += 80)]);
  const frames = play(arrivals, arrivals.at(-1)![0] + 1200);
  const buckets = new Map<number, number>();
  for (let i = 1; i < frames.length; i++) buckets.set(Math.floor(frames[i][0] / 100), (buckets.get(Math.floor(frames[i][0] / 100)) ?? 0) + frames[i][1] - frames[i - 1][1]);
  const during = [...buckets].filter(([b]) => b >= 6 && b < arrivals.at(-1)![0] / 100).map(([, n]) => n);
  assert.ok(during.filter((n) => n > 0).length / during.length >= 0.8, 'words keep coming between pieces');
});

test('a joined stream shows at once, an ended one finishes quickly, and a rewritten one shows whole', () => {
  const reveal = new StreamReveal();
  assert.equal(reveal.advance('text:1', reply.slice(0, 900), FRAME, { join: true }), 900);
  assert.equal(reveal.pending, false);

  const ending = new StreamReveal();
  ending.advance('text:2', reply.slice(0, 600), FRAME);
  let t = 0;
  while (ending.pending && t < 1000) {
    ending.advance('text:2', reply.slice(0, 600), FRAME, { ended: true });
    t += FRAME;
  }
  assert.ok(t <= REVEAL_END_MS + 3 * FRAME, `ended streams finish within ${REVEAL_END_MS} ms (${t})`);

  const rewritten = new StreamReveal();
  for (let i = 0; i < 20; i++) rewritten.advance('text:3', reply.slice(0, 300), FRAME);
  assert.equal(rewritten.advance('text:3', `trimmed ${reply.slice(100, 400)}`, FRAME), 308);
  assert.equal(rewritten.advance('text:4', 'A new stream', 0), 0, 'a new key starts over');
});

test('a word still being written waits briefly for the rest of it', () => {
  const reveal = new StreamReveal();
  let shown = 0;
  for (let i = 0; i < 30; i++) shown = reveal.advance('text:1', 'Hello wor', FRAME);
  assert.equal(shown, 9, 'a lone partial word shows once it has waited');
  const fresh = new StreamReveal();
  for (let i = 0; i < 5; i++) shown = fresh.advance('text:2', 'Hello wor', FRAME);
  assert.equal(shown, 6, 'held back at first');
});
