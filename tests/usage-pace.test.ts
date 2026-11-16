import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UsagePaceTracker, type BusyWorker } from '../src/server/subscriptions/pace.js';
import { paceWords, type SubscriptionProvider, type UsagePace } from '../src/shared/subscriptions.js';

const OPUS = 'custom:droidproxy:opus-5-5';
const SONNET = 'custom:droidproxy:sonnet-5-5';
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 16, 3, 0);
const WEEK_RESET = T0 + 4 * 24 * 60 * MIN;

/** Claude as DroidProxy reported it on the owner's account (5-hour, Weekly and Weekly (Opus) windows). */
function claude(used: { five: number; week: number; opus?: number; fiveReset?: number }, stamp: number, accounts = 1): SubscriptionProvider {
  return {
    key: 'claude',
    name: 'Claude',
    enabled: true,
    connect: 'browser',
    accounts: Array.from({ length: accounts }, (_, i) => ({
      id: `claude-${i}.json`,
      label: `owner${i}@example.com`,
      expired: false,
      disabled: false,
      usageUpdatedAt: stamp,
      windows: [
        { name: '5-hour', usedPercent: used.five, resetsAt: used.fiveReset ?? T0 + 5 * 60 * MIN },
        { name: 'Weekly', usedPercent: used.week, resetsAt: WEEK_RESET },
        ...(used.opus !== undefined ? [{ name: 'Weekly (Opus)', usedPercent: used.opus, resetsAt: WEEK_RESET }] : []),
      ],
    })),
  };
}

/** Observes `busy` once a minute for `minutes`, as the subscriptions loop does, from `from`. */
function busyFor(tracker: UsagePaceTracker, busy: BusyWorker[], from: number, minutes: number): number {
  for (let m = 0; m <= minutes; m++) tracker.observe(busy, from + m * MIN);
  return from + minutes * MIN;
}

const tmp = (t: { after(fn: () => void): void }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'usage-pace-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'usage-pace.json');
};

const measured = (p: UsagePace | undefined) => {
  assert.equal(p?.state, 'measured');
  return p as Extract<UsagePace, { state: 'measured' }>;
};

test('a worker-hour on one model turns the percent left into worker-hours for that model', (t) => {
  const file = tmp(t);
  const tracker = new UsagePaceTracker(file);
  const opus = [{ provider: 'claude' as const, model: OPUS }];
  let at = T0;
  tracker.sample([claude({ five: 10, week: 60, opus: 20 }, at)], at);
  assert.deepEqual(tracker.estimate(claude({ five: 10, week: 60 }, at), OPUS, at), { state: 'learning', workerHours: 0, needHours: 0.5 });
  for (let i = 1; i <= 6; i++) {
    at = busyFor(tracker, opus, at, 5);
    tracker.sample([claude({ five: 10 + 2 * i, week: 60 + 0.5 * i, opus: 20 + i }, at)], at);
  }
  const now = claude({ five: 22, week: 63, opus: 26 }, at);
  const pace = measured(tracker.estimate(now, OPUS, at));
  assert.equal(pace.basis, 'model');
  assert.ok(Math.abs(pace.workerHours - 0.5) < 1e-9);
  const byName = Object.fromEntries(pace.windows.map((w) => [w.name, w]));
  assert.ok(Math.abs(byName['5-hour'].perHour - 24) < 1e-9);
  assert.ok(Math.abs(byName['5-hour'].hoursLeft! - 78 / 24) < 1e-9);
  assert.ok(Math.abs(byName.Weekly.perHour - 6) < 1e-9);
  assert.equal(byName.Weekly.leftPercent, 37);
  assert.ok(Math.abs(byName['Weekly (Opus)'].perHour - 12) < 1e-9);
  assert.equal(
    paceWords(pace, 'claude'),
    '5-hour ~24% per worker-hour (about 3.3 worker-hours left), Weekly ~6% per worker-hour (about 6.2 worker-hours left), Weekly (Opus) ~12% per worker-hour (about 6.2 worker-hours left); measured over 0.5 worker-hours on this model in the last 7 days',
  );
  // Sonnet has no history of its own: it gets Claude's overall pace, and the Opus-only window is not its limit.
  const sonnet = measured(tracker.estimate(now, SONNET, at));
  assert.equal(sonnet.basis, 'provider');
  assert.deepEqual(
    sonnet.windows.map((w) => w.name),
    ['5-hour', 'Weekly'],
  );
  assert.match(paceWords(sonnet, 'claude'), /on all Claude models/);

  // The history survives a restart.
  const reread = new UsagePaceTracker(file);
  assert.deepEqual(reread.estimate(now, OPUS, at), tracker.estimate(now, OPUS, at));
});

test('two workers at once count double, resets are skipped, late usage joins the work before it, and usage while nobody worked is ignored', (t) => {
  const tracker = new UsagePaceTracker(tmp(t));
  const both = [
    { provider: 'claude' as const, model: OPUS },
    { provider: 'claude' as const, model: SONNET },
  ];
  let at = T0;
  tracker.sample([claude({ five: 0, week: 10 }, at)], at);
  // 15 minutes with two busy workers: 0.5 worker-hours.
  at = busyFor(tracker, both, at, 15);
  tracker.sample([claude({ five: 8, week: 12 }, at)], at);
  // Nobody busy, but the last turn's usage lands in the next sample.
  at = busyFor(tracker, [], at, 5);
  tracker.sample([claude({ five: 10, week: 13 }, at)], at);
  // Nobody busy again: this usage came from outside the office.
  at = busyFor(tracker, [], at, 5);
  tracker.sample([claude({ five: 40, week: 20 }, at)], at);
  const pace = measured(tracker.estimate(claude({ five: 40, week: 20 }, at), SONNET, at));
  assert.equal(pace.basis, 'provider', 'neither model owned the time');
  assert.ok(Math.abs(pace.workerHours - 0.5) < 1e-9);
  const rate = Object.fromEntries(pace.windows.map((w) => [w.name, w.perHour]));
  assert.ok(Math.abs(rate['5-hour'] - 20) < 1e-9, '(8 + 2) points over 0.5 worker-hours');
  assert.ok(Math.abs(rate.Weekly - 6) < 1e-9, '(2 + 1) points over 0.5 worker-hours');

  // The 5-hour window resets mid-interval: only Weekly counts for that stretch.
  at = busyFor(tracker, both, at, 15);
  tracker.sample([claude({ five: 3, week: 25, fiveReset: at + 5 * 60 * MIN }, at)], at);
  const after = measured(tracker.estimate(claude({ five: 3, week: 25 }, at), SONNET, at));
  const rate2 = Object.fromEntries(after.windows.map((w) => [w.name, w.perHour]));
  assert.ok(Math.abs(after.workerHours - 1) < 1e-9);
  assert.ok(Math.abs(rate2['5-hour'] - 20) < 1e-9, 'the reset interval adds no 5-hour points or hours');
  assert.ok(Math.abs(rate2.Weekly - 8 / 1) < 1e-9, '(3 + 5) weekly points over 1 worker-hour');
});

test('a gap while the Mac slept is not busy time, and a repeated sample changes nothing', (t) => {
  const tracker = new UsagePaceTracker(tmp(t));
  const opus = [{ provider: 'claude' as const, model: OPUS }];
  let at = T0;
  tracker.sample([claude({ five: 0, week: 0 }, at)], at);
  tracker.observe(opus, at);
  at += 8 * 60 * MIN;
  tracker.observe(opus, at);
  tracker.sample([claude({ five: 1, week: 1 }, at)], at);
  tracker.sample([claude({ five: 1, week: 1 }, at)], at + MIN);
  const pace = tracker.estimate(claude({ five: 1, week: 1 }, at), OPUS, at);
  assert.deepEqual(pace, { state: 'learning', workerHours: 3 / 60, needHours: 0.5 });
  assert.equal(paceWords(pace!, 'claude'), 'still learning: 0.1 of 0.5 worker-hours measured on Claude in the last 7 days');
});

test('several accounts add up what is left, and history older than a week drops out', (t) => {
  const tracker = new UsagePaceTracker(tmp(t));
  const opus = [{ provider: 'claude' as const, model: OPUS }];
  let at = T0;
  tracker.sample([claude({ five: 0, week: 50 }, at, 2)], at);
  at = busyFor(tracker, opus, at, 30);
  // Requests go to one account at a time: the first moves, the second stays.
  const moved = claude({ five: 0, week: 50 }, at, 2);
  moved.accounts[0].windows[1].usedPercent = 53;
  tracker.sample([moved], at);
  const pace = measured(tracker.estimate(moved, OPUS, at));
  const weekly = pace.windows.find((w) => w.name === 'Weekly')!;
  assert.equal(pace.accounts, 2);
  assert.equal(weekly.leftPercent, 47 + 50);
  assert.ok(Math.abs(weekly.perHour - 6) < 1e-9);
  assert.match(paceWords(pace, 'claude'), /across 2 accounts$/);
  const later = at + 8 * 24 * 60 * MIN;
  assert.equal(tracker.estimate(moved, OPUS, later)?.state, 'learning');
});
