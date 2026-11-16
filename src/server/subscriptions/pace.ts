// How far a plan's remaining quota goes, measured instead of looked up: every usage sample DroidProxy
// gives is paired with how many of the office's workers were busy on each of that provider's models
// since the previous sample, so a window's "35% left" becomes busy worker-hours whatever plan tier
// the account is on (docs/subscriptions.md#pace).

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isSubscriptionProvider, windowCovers, type SubscriptionAccount, type SubscriptionProvider, type SubscriptionProviderKey, type UsagePace, type UsagePaceWindow, type UsageWindow } from '../../shared/subscriptions.js';

/** How far back the rates look. */
export const PACE_HISTORY_MS = 7 * 24 * 60 * 60_000;
/** Busy worker-hours a rate needs before it is shown. */
export const PACE_MIN_HOURS = 0.5;
/** One gap between observations counts for at most this long: a sleeping Mac is not a busy worker. */
const MAX_STEP_MS = 3 * 60_000;
/** A model owns an interval when it had at least this share of the provider's busy time. */
const OWN_SHARE = 0.9;
const MAX_INTERVALS = 6000;
const HOUR = 60 * 60_000;

/** A worker busy on a subscription model right now. */
export interface BusyWorker {
  provider: SubscriptionProviderKey;
  model: string;
}

/** Between two usage samples of one provider: busy ms per model, and percentage points used per window (absent when it reset). */
export interface PaceInterval {
  provider: SubscriptionProviderKey;
  from: number;
  to: number;
  busy: Record<string, number>;
  used: Record<string, number>;
}

interface AccountSnap {
  stamp: number | undefined;
  windows: Map<string, { used: number; resetsAt: number | null }>;
}

interface ProviderSnap {
  at: number;
  accounts: Map<string, AccountSnap>;
}

const live = (p: SubscriptionProvider): SubscriptionAccount[] => p.accounts.filter((a) => !a.expired && !a.disabled && a.windows.length);
const total = (busy: Record<string, number>) => Object.values(busy).reduce((s, ms) => s + ms, 0);

function snapshot(accounts: readonly SubscriptionAccount[], at: number): ProviderSnap {
  return {
    at,
    accounts: new Map(
      accounts.map((a) => [
        a.id,
        {
          stamp: a.usageUpdatedAt,
          windows: new Map(a.windows.filter((w) => Number.isFinite(w.usedPercent)).map((w) => [w.name, { used: w.usedPercent, resetsAt: w.resetsAt }])),
        },
      ]),
    ),
  };
}

/** A new sample: an account's sample time moved, or (with no sample times) a percentage or reset time moved. */
function moved(prev: ProviderSnap, next: ProviderSnap): boolean {
  if (prev.accounts.size !== next.accounts.size) return true;
  for (const [id, a] of next.accounts) {
    const b = prev.accounts.get(id);
    if (!b) return true;
    if (a.stamp !== b.stamp) return true;
    if (a.stamp !== undefined) continue;
    if (b.windows.size !== a.windows.size) return true;
    for (const [name, w] of a.windows) {
      const was = b.windows.get(name);
      if (!was || was.used !== w.used || was.resetsAt !== w.resetsAt) return true;
    }
  }
  return false;
}

const safeKey = (k: string): boolean => k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
const isCountMap = (v: unknown): v is Record<string, number> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !Object.hasOwn(v, '__proto__') && Object.entries(v).every(([k, n]) => safeKey(k) && typeof n === 'number' && Number.isFinite(n) && n >= 0);

function isInterval(v: unknown): v is PaceInterval {
  const i = v as PaceInterval;
  return !!i && typeof i === 'object' && isSubscriptionProvider(i.provider) && Number.isFinite(i.from) && Number.isFinite(i.to) && isCountMap(i.busy) && isCountMap(i.used);
}

/**
 * Office-wide `.droid-office/usage-pace.json`: the last 7 days of intervals in which an office worker
 * was busy on a provider (usage from the sample right after is added to them, since it lands late).
 * Usage that moved while nobody in the office was busy (the owner chatting elsewhere) is left out.
 */
export class UsagePaceTracker {
  revision = 0;
  private intervals: PaceInterval[] = [];
  private readonly snaps = new Map<SubscriptionProviderKey, ProviderSnap>();
  private readonly pending = new Map<SubscriptionProviderKey, Record<string, number>>();
  private readonly lastBusy = new Map<SubscriptionProviderKey, boolean>();
  private busyNow: readonly BusyWorker[] = [];
  private observedAt?: number;
  private tempCount = 0;

  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { intervals?: unknown };
      if (Array.isArray(raw?.intervals)) this.intervals = raw.intervals.filter(isInterval).slice(-MAX_INTERVALS);
    } catch {
      // A fresh office, or an unreadable file: start learning again.
    }
  }

  /** Who is busy now; the time since the last call is credited to whoever was busy then. */
  observe(busy: readonly BusyWorker[], at: number): void {
    if (this.observedAt !== undefined) {
      const step = Math.min(Math.max(0, at - this.observedAt), MAX_STEP_MS);
      if (step > 0)
        for (const w of this.busyNow) {
          if (!safeKey(w.model)) continue;
          const acc = this.pending.get(w.provider) ?? {};
          acc[w.model] = (Object.hasOwn(acc, w.model) ? acc[w.model] : 0) + step;
          this.pending.set(w.provider, acc);
        }
    }
    this.observedAt = at;
    this.busyNow = [...busy];
  }

  /** The providers as last read: each new usage sample closes an interval for its provider. */
  sample(providers: readonly SubscriptionProvider[], at: number): void {
    let changed = false;
    const seen = new Set<SubscriptionProviderKey>();
    for (const p of providers) {
      const accounts = live(p);
      if (!accounts.length) continue;
      seen.add(p.key);
      const next = snapshot(accounts, at);
      const prev = this.snaps.get(p.key);
      if (prev && !moved(prev, next)) continue;
      this.snaps.set(p.key, next);
      const busy = this.pending.get(p.key) ?? {};
      this.pending.delete(p.key);
      if (!prev) continue;
      const used: Record<string, number> = {};
      const reset = new Set<string>();
      for (const [id, a] of next.accounts) {
        const b = prev.accounts.get(id);
        if (!b) continue;
        for (const [name, w] of a.windows) {
          if (!safeKey(name)) continue;
          const was = b.windows.get(name);
          if (!was) continue;
          const crossedReset = was.resetsAt !== null && was.resetsAt <= at && (was.resetsAt > prev.at || w.resetsAt !== was.resetsAt);
          if (w.used < was.used - 0.5 || crossedReset) reset.add(name);
          else used[name] = (Object.hasOwn(used, name) ? used[name] : 0) + Math.max(0, w.used - was.used);
        }
      }
      // Busy time isn't split by account: if any account reset, omit this window for the whole interval (flat windows stay as 0).
      for (const name of reset) delete used[name];
      const busyMs = total(busy);
      const wasBusy = this.lastBusy.get(p.key) ?? false;
      this.lastBusy.set(p.key, busyMs > 0);
      if (busyMs > 0) {
        this.intervals.push({ provider: p.key, from: prev.at, to: at, busy, used });
        changed = true;
      } else if (wasBusy) {
        // Usage often lands a sample late: add it to the non-reset windows (already seeded with 0) of the busy interval just before.
        for (let i = this.intervals.length - 1; i >= 0; i--) {
          const prior = this.intervals[i];
          if (prior.provider !== p.key) continue;
          for (const [name, n] of Object.entries(used))
            if (n > 0 && Object.hasOwn(prior.used, name)) {
              prior.used[name] += n;
              changed = true;
            }
          break;
        }
      }
    }
    for (const key of [...this.snaps.keys(), ...this.pending.keys()]) {
      if (!seen.has(key)) {
        this.snaps.delete(key);
        this.pending.delete(key);
        this.lastBusy.delete(key);
      }
    }
    const before = this.intervals.length;
    this.intervals = this.intervals.filter((i) => i.to >= at - PACE_HISTORY_MS).slice(-MAX_INTERVALS);
    if (changed || this.intervals.length !== before) {
      this.revision++;
      this.persist();
    }
  }

  /**
   * How far `provider`'s remaining quota goes for `model` (or for any of its models when `model` is
   * undefined): this model's own rate once it has PACE_MIN_HOURS of history, else the provider's.
   */
  estimate(provider: SubscriptionProvider, model: string | undefined, at: number): UsagePace | undefined {
    const accounts = live(provider);
    if (!accounts.length) return undefined;
    const recent = this.intervals.filter((i) => i.provider === provider.key && i.to >= at - PACE_HISTORY_MS);
    const hours = (list: readonly PaceInterval[]) => list.reduce((s, i) => s + total(i.busy), 0) / HOUR;
    const own = model
      ? recent.filter((i) => {
          const busyMs = total(i.busy);
          return busyMs > 0 && (Object.hasOwn(i.busy, model) ? i.busy[model] : 0) >= OWN_SHARE * busyMs;
        })
      : [];
    const basis = hours(own) >= PACE_MIN_HOURS ? 'model' : 'provider';
    const pool = basis === 'model' ? own : recent;
    const poolHours = hours(pool);
    if (poolHours < PACE_MIN_HOURS) return { state: 'learning', workerHours: poolHours, needHours: PACE_MIN_HOURS };
    const metered = new Map<string, UsageWindow>();
    for (const a of accounts) for (const w of a.windows) if ((!model || windowCovers(w, model)) && !metered.has(w.name)) metered.set(w.name, w);
    const windows: UsagePaceWindow[] = [];
    let bestHours = 0;
    for (const [name, spec] of metered) {
      // Only time on models this window meters counts: Sonnet hours spend nothing of `Weekly (Opus)`.
      const exposed = (i: PaceInterval) => Object.entries(i.busy).reduce((s, [m, ms]) => s + (windowCovers(spec, m) ? ms : 0), 0);
      // Flat intervals keep used[name] = 0 and count; only intervals where this window reset (or wasn't reported) lack the key.
      const counted = pool.filter((i) => Object.hasOwn(i.used, name) && exposed(i) > 0);
      const h = counted.reduce((s, i) => s + exposed(i), 0) / HOUR;
      if (h > bestHours) bestHours = h;
      if (h < PACE_MIN_HOURS) continue;
      const perHour = counted.reduce((s, i) => s + i.used[name], 0) / h;
      const leftPercent = accounts.reduce((s, a) => {
        const w = a.windows.find((x) => x.name === name);
        return s + (w && Number.isFinite(w.usedPercent) ? Math.max(0, 100 - w.usedPercent) : 0);
      }, 0);
      windows.push({ name, perHour, leftPercent, hoursLeft: perHour >= 0.05 ? leftPercent / perHour : null });
    }
    if (!windows.length) return { state: 'learning', workerHours: bestHours, needHours: PACE_MIN_HOURS };
    return { state: 'measured', basis, workerHours: poolHours, accounts: accounts.length, windows };
  }

  private persist(): void {
    if (!this.file) return;
    // Pid and a counter, not randomUUID(): on Node 26 randomUUID leaves a resource open that the
    // subscriptions tests wait on. Writes are synchronous, so two temp names never overlap.
    const temp = `${this.file}.${process.pid}.${this.tempCount++}.tmp`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(temp, JSON.stringify({ intervals: this.intervals }), { flag: 'wx' });
      renameSync(temp, this.file);
    } catch {
      try {
        unlinkSync(temp);
      } catch {}
    }
  }
}
