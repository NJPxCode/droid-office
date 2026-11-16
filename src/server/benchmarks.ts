// Office-wide Artificial Analysis connection: the owner's Data API key, and the public model
// benchmarks read with it once a day for team_models (docs/subscriptions.md#benchmarks).

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { benchmarkName, matchBenchmark, type BenchmarkModel, type BenchmarksState, type BenchmarkVariant } from '../shared/benchmarks.js';
import { AIRGAPPED_REASON } from '../shared/setup.js';
import { durationWords } from '../shared/subscriptions.js';

/** The free tier's model list; the full list needs a paid plan. */
export const BENCHMARKS_URL = 'https://artificialanalysis.ai/api/v2/language/models/free';
export const BENCHMARKS_REFRESH_MS = 24 * 60 * 60_000;
/** How often the office looks whether a day has passed, and the least time between two failed reads. */
const CHECK_EVERY_MS = 60 * 60_000;
const FIRST_CHECK_MS = 15_000;
/** The free tier allows 100 requests a day; the list is about four pages. */
const PAGE_MAX = 10;
const TIMEOUT_MS = 20_000;

export interface BenchmarksTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BenchmarksOptions {
  /** The office's .droid-office. */
  dataDir: string;
  broadcast(state: BenchmarksState): void;
  /** Airgapped: no reads. */
  paused(): boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timers?: BenchmarksTimers;
}

interface Persisted {
  apiKey?: string;
  at?: number;
  by?: string;
  fetchedAt?: number;
  error?: string;
  models?: BenchmarkModel[];
}

export function isValidBenchmarksKey(key: unknown): key is string {
  return typeof key === 'string' && /^[\x21-\x7e]{8,256}$/.test(key.trim());
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** The rows of one `/language/models/free` page, grouped by model family with one variant per effort. */
export function groupBenchmarks(rows: readonly unknown[], into: BenchmarkModel[] = []): BenchmarkModel[] {
  for (const raw of rows) {
    const row = obj(raw);
    if (typeof row.name !== 'string' || !row.name.trim()) continue;
    const { base, effort } = benchmarkName(row.name);
    const evals = obj(row.evaluations);
    const variant: BenchmarkVariant = {
      ...(effort ? { effort } : {}),
      intelligence: num(evals.artificial_analysis_intelligence_index),
      engineering: num(evals.artificial_analysis_engineering_index),
      costPerTask: num(obj(obj(row.artificial_analysis_intelligence_index_cost).cost_per_task).total_cost),
      tokensPerSecond: num(obj(row.performance_v3).mean_output_tokens_per_second),
    };
    if (variant.intelligence === null && variant.engineering === null) continue;
    let model = into.find((m) => m.name === base);
    if (!model) {
      model = { name: base, variants: [] };
      into.push(model);
    }
    if (!model.variants.some((v) => v.effort === variant.effort)) model.variants.push(variant);
  }
  return into;
}

function isModel(v: unknown): v is BenchmarkModel {
  const m = v as BenchmarkModel;
  return !!m && typeof m.name === 'string' && Array.isArray(m.variants);
}

export class Benchmarks {
  private readonly file: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timers: BenchmarksTimers;
  private key?: string;
  private at?: number;
  private by?: string;
  private fetchedAt?: number;
  private error?: string;
  private list: BenchmarkModel[] = [];
  private reading: Promise<string | undefined> | null = null;
  private triedAt = Number.NEGATIVE_INFINITY;
  private timer: unknown;
  private stopped = false;
  /** Moves on every connect and disconnect, so a read that started before one never saves over it. */
  private gen = 0;

  constructor(private readonly opts: BenchmarksOptions) {
    this.file = path.join(opts.dataDir, 'artificial-analysis.json');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? {
      setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      },
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Persisted;
      if (isValidBenchmarksKey(raw?.apiKey)) this.key = raw.apiKey.trim();
      if (num(raw?.at) !== null) this.at = raw.at;
      if (typeof raw?.by === 'string') this.by = raw.by;
      if (num(raw?.fetchedAt) !== null) this.fetchedAt = raw.fetchedAt;
      if (typeof raw?.error === 'string' && raw.error) this.error = raw.error;
      if (Array.isArray(raw?.models)) this.list = raw.models.filter(isModel);
    } catch {
      // Not connected yet.
    }
    this.schedule(FIRST_CHECK_MS);
  }

  state(): BenchmarksState {
    if (!this.key) return { connected: false, models: 0 };
    return {
      connected: true,
      fingerprint: this.key.slice(-4),
      ...(this.at !== undefined ? { at: this.at } : {}),
      ...(this.fetchedAt !== undefined ? { fetchedAt: this.fetchedAt } : {}),
      models: this.list.length,
      ...(this.reading ? { checking: true } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** The benchmarks for a Droid model by its display name, while connected. */
  forModel(displayName: string): BenchmarkModel | undefined {
    return this.key ? matchBenchmark(displayName, this.list) : undefined;
  }

  /** Reads the benchmarks with `key` and keeps it only when that works; resolves with why not. */
  async connect(key: string, by: string): Promise<string | undefined> {
    if (!isValidBenchmarksKey(key)) return 'Enter a valid Artificial Analysis API key.';
    if (this.opts.paused()) return AIRGAPPED_REASON;
    const trimmed = key.trim();
    const gen = ++this.gen;
    const read = await this.read(trimmed);
    if (gen !== this.gen || this.stopped) return 'The Artificial Analysis connection changed while the key was being checked; nothing was saved.';
    if (typeof read === 'string') return read;
    const prev = this.snapshot();
    this.key = trimmed;
    this.at = this.now();
    this.by = by;
    this.fetchedAt = this.now();
    this.error = undefined;
    this.list = read;
    const err = this.persist();
    if (err) this.restore(prev);
    this.publish();
    return err;
  }

  disconnect(): string | undefined {
    this.gen++;
    const prev = this.snapshot();
    this.restore({});
    const err = this.persist();
    if (err) this.restore(prev);
    this.publish();
    return err;
  }

  /** Reads the benchmarks again now; resolves with why that failed. */
  async refresh(): Promise<string | undefined> {
    if (!this.key) return 'Connect an Artificial Analysis API key first.';
    if (this.opts.paused()) return AIRGAPPED_REASON;
    if (this.reading) return this.reading;
    const key = this.key;
    const gen = this.gen;
    this.reading = (async () => {
      this.triedAt = this.now();
      const read = await this.read(key);
      if (this.key !== key || gen !== this.gen) return undefined;
      if (typeof read === 'string') {
        this.error = read;
        this.persist();
        return read;
      }
      this.list = read;
      this.fetchedAt = this.now();
      this.error = this.persist();
      return this.error;
    })();
    this.publish();
    try {
      return await this.reading;
    } finally {
      this.reading = null;
      this.publish();
    }
  }

  stop(): void {
    this.stopped = true;
    this.timers.clearTimeout(this.timer);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = this.timers.setTimeout(() => {
      const t = this.now();
      const due = this.key && !this.opts.paused() && (this.fetchedAt === undefined || t - this.fetchedAt >= BENCHMARKS_REFRESH_MS) && t - this.triedAt >= CHECK_EVERY_MS;
      void (due ? this.refresh() : Promise.resolve()).finally(() => this.schedule(CHECK_EVERY_MS));
    }, ms);
  }

  /** Every page of the free model list, grouped; or why it couldn't be read (never naming the key). */
  private async read(key: string): Promise<BenchmarkModel[] | string> {
    const models: BenchmarkModel[] = [];
    for (let page = 1; page <= PAGE_MAX; page++) {
      if (this.opts.paused()) return AIRGAPPED_REASON;
      let res: Response;
      try {
        res = await this.fetchImpl(`${BENCHMARKS_URL}?page=${page}`, { headers: { 'x-api-key': key, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        return 'Could not reach Artificial Analysis.';
      }
      if (!res.ok) return this.failure(res, key);
      let body: Record<string, unknown>;
      try {
        body = obj(await res.json());
      } catch {
        return 'Artificial Analysis sent something that is not JSON.';
      }
      if (!Array.isArray(body.data)) return 'Artificial Analysis sent no model list.';
      groupBenchmarks(body.data, models);
      if (obj(body.pagination).has_more !== true) break;
    }
    return models.length ? models : 'Artificial Analysis listed no benchmarked models.';
  }

  private async failure(res: Response, key: string): Promise<string> {
    if (res.status === 401) return 'Artificial Analysis rejected the key.';
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after'));
      return `Artificial Analysis's daily request limit is used up${Number.isFinite(wait) && wait > 0 ? `; it resets in ${durationWords(wait * 1000)}` : ''}.`;
    }
    let said = '';
    try {
      const e = obj(await res.json()).error;
      if (typeof e === 'string') said = e.split(key).join('…').slice(0, 200);
    } catch {}
    return `Artificial Analysis answered ${res.status}${said ? `: ${said}` : ''}.`;
  }

  private publish(): void {
    if (!this.stopped) this.opts.broadcast(this.state());
  }

  private snapshot(): Persisted {
    return { apiKey: this.key, at: this.at, by: this.by, fetchedAt: this.fetchedAt, error: this.error, models: this.list };
  }

  private restore(s: Persisted): void {
    this.key = s.apiKey;
    this.at = s.at;
    this.by = s.by;
    this.fetchedAt = s.fetchedAt;
    this.error = s.error;
    this.list = s.models ?? [];
  }

  private persist(): string | undefined {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const disk: Persisted = this.key ? Object.fromEntries(Object.entries(this.snapshot()).filter(([, v]) => v !== undefined)) : {};
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(temp, JSON.stringify(disk), { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.file);
      return undefined;
    } catch {
      try {
        unlinkSync(temp);
      } catch {}
      return 'Could not save the Artificial Analysis settings to disk.';
    }
  }
}
