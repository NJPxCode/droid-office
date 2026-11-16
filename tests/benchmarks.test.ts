import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Benchmarks, BENCHMARKS_REFRESH_MS, BENCHMARKS_URL, groupBenchmarks } from '../src/server/benchmarks.js';
import { benchmarkName, benchmarkWords, matchBenchmark, nameKey } from '../src/shared/benchmarks.js';

/** Rows from the owner's `GET /api/v2/language/models/free` (November 2026), trimmed to the fields the office reads. */
const PAGE_1 = [
  {
    slug: 'glm-4-5v',
    name: 'GLM-4.5V (Non-reasoning)',
    evaluations: { artificial_analysis_intelligence_index: null, artificial_analysis_engineering_index: null },
    artificial_analysis_intelligence_index_cost: null,
    performance_v3: { mean_output_tokens_per_second: 44.73 },
  },
  {
    slug: 'kimi-k2-6',
    name: 'Kimi K2.6 (Reasoning)',
    evaluations: { artificial_analysis_intelligence_index: null, artificial_analysis_engineering_index: null },
    artificial_analysis_intelligence_index_cost: null,
    performance_v3: { mean_output_tokens_per_second: 40.63 },
  },
  {
    slug: 'claude-haiku-5-5-high',
    name: 'Claude Haiku 5.5 (High)',
    evaluations: { artificial_analysis_intelligence_index: 29.9, artificial_analysis_engineering_index: 36.5 },
    artificial_analysis_intelligence_index_cost: { total_cost: 121.41, cost_per_task: { total_cost: 0.1586 } },
    performance_v3: { mean_output_tokens_per_second: 224.23 },
  },
  {
    slug: 'claude-opus-5-5',
    name: 'Claude Opus 5.5 (Max, Default Fallback)',
    evaluations: { artificial_analysis_intelligence_index: 59.1, artificial_analysis_engineering_index: 65.3 },
    artificial_analysis_intelligence_index_cost: { total_cost: 8909.67, cost_per_task: { total_cost: 10.0364 } },
    performance_v3: { mean_output_tokens_per_second: 116.23 },
  },
  {
    slug: 'gpt-6-1-sol-high',
    name: 'GPT-6.1 Sol (High)',
    evaluations: { artificial_analysis_intelligence_index: 50.3, artificial_analysis_engineering_index: 55.4 },
    artificial_analysis_intelligence_index_cost: { total_cost: 573.17, cost_per_task: { total_cost: 0.591 } },
    performance_v3: { mean_output_tokens_per_second: 49.67 },
  },
];
const PAGE_2 = [
  {
    slug: 'claude-opus-5-5-low',
    name: 'Claude Opus 5.5 (Low, Default Fallback)',
    evaluations: { artificial_analysis_intelligence_index: 34.8, artificial_analysis_engineering_index: 43.2 },
    artificial_analysis_intelligence_index_cost: { total_cost: 979.66, cost_per_task: { total_cost: 0.9755 } },
    performance_v3: { mean_output_tokens_per_second: 104.68 },
  },
  {
    slug: 'gpt-6-1-sol-medium',
    name: 'GPT-6.1 Sol (Medium)',
    evaluations: { artificial_analysis_intelligence_index: 46.3, artificial_analysis_engineering_index: 52.1 },
    artificial_analysis_intelligence_index_cost: { total_cost: 388.57, cost_per_task: { total_cost: 0.3594 } },
    performance_v3: { mean_output_tokens_per_second: 51.93 },
  },
  {
    slug: 'claude-opus-5-5-medium',
    name: 'Claude Opus 5.5 (Medium, Default Fallback)',
    evaluations: { artificial_analysis_intelligence_index: 48.2, artificial_analysis_engineering_index: 53.7 },
    artificial_analysis_intelligence_index_cost: { total_cost: 2031.27, cost_per_task: { total_cost: 2.4511 } },
    performance_v3: { mean_output_tokens_per_second: 106.26 },
  },
  {
    slug: 'gemini-1-5-pro',
    name: "Gemini 1.5 Pro (Sep '24)",
    evaluations: { artificial_analysis_intelligence_index: 30, artificial_analysis_engineering_index: null },
    artificial_analysis_intelligence_index_cost: null,
    performance_v3: { mean_output_tokens_per_second: null },
  },
];
const KEY = 'aa_TestKeyNotReal1234';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

test('Artificial Analysis names group by family and effort, and match Droid model names', () => {
  assert.deepEqual(benchmarkName('Claude Opus 5.5 (High, Default Fallback)'), { base: 'Claude Opus 5.5', effort: 'high' });
  assert.deepEqual(benchmarkName('Kimi K2.6 (Non-reasoning)'), { base: 'Kimi K2.6', effort: 'non-reasoning' });
  assert.deepEqual(benchmarkName("Gemini 1.5 Pro (Sep '24)"), { base: "Gemini 1.5 Pro (Sep '24)" });
  assert.equal(nameKey('DroidProxy: GPT 6.1 Sol'), nameKey('GPT-6.1 Sol'));
  assert.equal(nameKey('DroidProxy: Opus 5.5'), nameKey('Claude Opus 5.5'));

  const models = groupBenchmarks([...PAGE_1, ...PAGE_2]);
  assert.deepEqual(
    models.map((m) => [m.name, m.variants.map((v) => v.effort ?? '-')]),
    [
      ['Claude Haiku 5.5', ['high']],
      ['Claude Opus 5.5', ['max', 'low', 'medium']],
      ['GPT-6.1 Sol', ['high', 'medium']],
      ["Gemini 1.5 Pro (Sep '24)", ['-']],
    ],
    'rows with no scores at all are left out',
  );
  assert.equal(matchBenchmark('DroidProxy: Opus 5.5', models)?.name, 'Claude Opus 5.5');
  assert.equal(matchBenchmark('Opus 5.5', models)?.name, 'Claude Opus 5.5');
  assert.equal(matchBenchmark('DroidProxy: GPT 6.1 Sol', models)?.name, 'GPT-6.1 Sol');
  assert.equal(matchBenchmark('Opus 5', models), undefined, 'a version prefix is a different model');
  assert.equal(matchBenchmark('GPT 6.1 Sol Mini', models), undefined);
  assert.equal(matchBenchmark('Gemini 1.5 Pro', models), undefined, 'a dated name is its own model');
});

test('benchmark lines put the default effort first and keep to the efforts the model takes', () => {
  const models = groupBenchmarks([...PAGE_1, ...PAGE_2]);
  const opus = matchBenchmark('DroidProxy: Opus 5.5', models)!;
  assert.equal(benchmarkWords(opus, EFFORTS, 'medium'), 'medium (default): intelligence 48.2, engineering 53.7, $2.45/task; low: intelligence 34.8, engineering 43.2, $0.98/task; max: intelligence 59.1, engineering 65.3, $10.0/task');
  assert.equal(benchmarkWords(opus, ['low', 'medium'], 'medium'), 'medium (default): intelligence 48.2, engineering 53.7, $2.45/task; low: intelligence 34.8, engineering 43.2, $0.98/task');
  assert.equal(benchmarkWords(matchBenchmark('Haiku 5.5', models)!, EFFORTS, 'medium'), 'intelligence 29.9, engineering 36.5, $0.16/task');
  assert.equal(benchmarkWords(models[3]), 'intelligence 30, engineering ?, $?/task');
});

function rig(t: { after(fn: () => void): void }, opts: { paused?: boolean; respond?: (url: string, key: string | null) => Response } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'benchmarks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.UTC(2026, 10, 16, 4);
  const calls: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const states: unknown[] = [];
  const pages = (url: string) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return Response.json({ tier: 'free', pagination: { page, page_size: 5, total_pages: 2, has_more: page < 2 }, data: page === 1 ? PAGE_1 : PAGE_2 });
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const key = new Headers(init?.headers).get('x-api-key');
    return opts.respond?.(url, key) ?? pages(url);
  }) as typeof fetch;
  const make = () =>
    new Benchmarks({
      dataDir: dir,
      broadcast: (s) => states.push(s),
      paused: () => opts.paused ?? false,
      fetchImpl,
      now: () => now,
      timers: { setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: () => {} },
    });
  return { dir, file: path.join(dir, 'artificial-analysis.json'), calls, timers, states, make, advance: (ms: number) => (now += ms), at: () => now };
}

test('connecting reads every page with the key, keeps the key private, and survives a restart', async (t) => {
  const r = rig(t);
  const b = r.make();
  assert.deepEqual(b.state(), { connected: false, models: 0 });
  assert.equal(await b.connect('not a key', 'owner'), 'Enter a valid Artificial Analysis API key.');
  assert.equal(await b.connect(KEY, 'owner'), undefined);
  assert.deepEqual(r.calls, [`${BENCHMARKS_URL}?page=1`, `${BENCHMARKS_URL}?page=2`]);
  assert.deepEqual(b.state(), { connected: true, fingerprint: '1234', at: r.at(), fetchedAt: r.at(), models: 4 });
  assert.equal(b.forModel('DroidProxy: GPT 6.1 Sol')?.variants.length, 2);
  assert.equal(statSync(r.file).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(r.states).includes(KEY), 'clients never see the key');

  const again = r.make();
  assert.equal(again.state().models, 4);
  assert.equal(again.forModel('Opus 5.5')?.name, 'Claude Opus 5.5');
  assert.equal(again.disconnect(), undefined);
  assert.deepEqual(again.state(), { connected: false, models: 0 });
  assert.equal(again.forModel('Opus 5.5'), undefined);
  assert.deepEqual(JSON.parse(readFileSync(r.file, 'utf8')), {});
});

test('a rejected key is not saved, and a failed refresh keeps the benchmarks it had', async (t) => {
  let answer: ((key: string | null) => Response) | undefined = (key) => (key === KEY ? Response.json({ status: 401, error: 'Unauthorized' }, { status: 401 }) : Response.json({}));
  const r = rig(t, { respond: (_url, key) => answer?.(key) });
  const b = r.make();
  assert.equal(await b.connect(KEY, 'owner'), 'Artificial Analysis rejected the key.');
  assert.equal(b.state().connected, false);

  answer = undefined;
  assert.equal(await b.connect(KEY, 'owner'), undefined);
  answer = () => new Response(JSON.stringify({ error: `Language models list requires a Pro subscription for ${KEY}` }), { status: 403 });
  assert.equal(await b.refresh(), 'Artificial Analysis answered 403: Language models list requires a Pro subscription for ….');
  answer = () => new Response('{}', { status: 429, headers: { 'retry-after': '7200' } });
  const limited = await b.refresh();
  assert.equal(limited, "Artificial Analysis's daily request limit is used up; it resets in 2 h.");
  assert.equal(b.state().error, limited);
  assert.equal(b.state().models, 4, 'the benchmarks from before stay in use');
  assert.ok(b.forModel('Opus 5.5'));
  answer = () => {
    throw new Error('offline');
  };
  assert.equal(await b.refresh(), 'Could not reach Artificial Analysis.');
});

test('benchmarks are read again once a day, never while airgapped', async (t) => {
  const r = rig(t);
  const b = r.make();
  await b.connect(KEY, 'owner');
  r.calls.length = 0;
  assert.equal(r.timers[0].ms, 15_000);
  r.timers.shift()!.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.calls.length, 0, 'read less than a day ago');
  r.advance(BENCHMARKS_REFRESH_MS);
  r.timers.shift()!.fn();
  for (let i = 0; i < 20 && r.calls.length < 2; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.calls.length, 2);
  assert.equal(b.state().fetchedAt, r.at());

  const paused = rig(t, { paused: true });
  writeFileSync(paused.file, readFileSync(r.file));
  const off = paused.make();
  assert.match((await off.refresh()) ?? '', /airgapped/i);
  paused.advance(BENCHMARKS_REFRESH_MS * 2);
  paused.timers.shift()!.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(paused.calls.length, 0);
});
