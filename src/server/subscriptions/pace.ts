// How far a plan's remaining quota goes, measured instead of looked up: every usage sample DroidProxy
// gives is paired with how many of the office's workers were busy on each of that provider's models
// since the previous sample, so a window's "35% left" becomes busy worker-hours whatever plan tier
// the account is on (docs/subscriptions.md#pace).

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isSubscriptionProvider, windowCovers, type SubscriptionAccount, type SubscriptionProvider, type SubscriptionProviderKey, type UsagePace, type UsagePaceWindow } from '../../shared/subscriptions.js';

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
    accounts: new Map(accounts.map((a) => [a.id, { stamp: a.usageUpdatedAt, windows: new Map(a.windows.map((w) => [w.name, { used: w.usedPercent, resetsAt: w.resetsAt }])) }])),
  };
}

/** A new sample: an account's sample time moved, or (with no sample times) a value moved. */
function moved(prev: ProviderSnap, next: ProviderSnap): boolean {
  for (const [id, a] of next.accounts) {
    const b = prev.accounts.get(id);
    if (!b) return true;
    if (a.stamp !== undefined || b.stamp !== undefined) {
      if (a.stamp !== b.stamp) return true;
      continue;
    }
    for (const [name, w] of a.windows) if (b.windows.get(name)?.used !== w.used) return true;
  }
  return false;
}

function isInterval(v: unknown): v is PaceInterval {
  const i = v as PaceInterval;
  return (
    !!i &&
    typeof i === 'object' &&
    isSubscriptionProvider(i.provider) &&
    Number.isFinite(i.from) &&
    Number.isFinite(i.to) &&
    !!i.busy &&
    typeof i.busy === 'object' &&
    Object.values(i.busy).every((n) => Number.isFinite(n) && n >= 0) &&
    !!i.used &&
    typeof i.used === 'object' &&
    Object.values(i.used).every((n) => Number.isFinite(n) && n >= 0)
  );
}

/**
 * Office-wide `.droid-office/usage-pace.json`: the last 7 days of intervals in which an office worker
 * was busy on a provider (usage from the sample right after is added to them, since it lands late).
 * Usage that moved while nobody in the office was busy (the owner chatting elsewhere) is left out.
 */
export class UsagePaceTracker {
  private intervals: PaceInterval[] = [];
  private readonly snaps = new Map<SubscriptionProviderKey, ProviderSnap>();
  private readonly pending = new Map<SubscriptionProviderKey, Record<string, number>>();
  private readonly lastBusy = new Map<SubscriptionProviderKey, boolean>();
  private busyNow: readonly BusyWorker[] = [];
  private observedAt?: number;

  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { intervals?: unknown };
      if (Array.isArray(raw?.intervals)) this.intervals = raw.intervals.filter(isInterval);
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
          const acc = this.pending.get(w.provider) ?? {};
          acc[w.model] = (acc[w.model] ?? 0) + step;
          this.pending.set(w.provider, acc);
        }
    }
    this.observedAt = at;
    this.busyNow = busy;
  }

  /** The providers as last read: each new usage sample closes an interval for its provider. */
  sample(providers: readonly SubscriptionProvider[], at: number): void {
    let changed = false;
    for (const p of providers) {
      const accounts = live(p);
      if (!accounts.length) continue;
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
          const was = b.windows.get(name);
          if (!was) continue;
          if (w.used < was.used - 0.5 || (was.resetsAt !== null && was.resetsAt <= at)) reset.add(name);
          else used[name] = (used[name] ?? 0) + Math.max(0, w.used - was.used);
        }
      }
      for (const name of reset) delete used[name];
      const busyMs = total(busy);
      const wasBusy = this.lastBusy.get(p.key) ?? false;
      this.lastBusy.set(p.key, busyMs > 0);
      if (busyMs > 0) {
        this.intervals.push({ provider: p.key, from: prev.at, to: at, busy, used });
        changed = true;
      } else if (wasBusy) {
        // Usage often lands a sample late: it belongs to the work just before.
        const last = [...this.intervals].reverse().find((i) => i.provider === p.key);
        if (last)
          for (const [name, n] of Object.entries(used))
            if (n > 0 && name in last.used) {
              last.used[name] += n;
              changed = true;
            }
      }
    }
    const before = this.intervals.length;
    this.intervals = this.intervals.filter((i) => i.to >= at - PACE_HISTORY_MS).slice(-MAX_INTERVALS);
    if (changed || this.intervals.length !== before) this.persist();
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
    const own = model ? recent.filter((i) => total(i.busy) > 0 && (i.busy[model] ?? 0) >= OWN_SHARE * total(i.busy)) : [];
    const basis = hours(own) >= PACE_MIN_HOURS ? 'model' : 'provider';
    const pool = basis === 'model' ? own : recent;
    const poolHours = hours(pool);
    if (poolHours < PACE_MIN_HOURS) return { state: 'learning', workerHours: poolHours, needHours: PACE_MIN_HOURS };
    const names: string[] = [];
    for (const a of accounts) for (const w of a.windows) if (windowCovers(w, model ?? '') && !names.includes(w.name)) names.push(w.name);
    const windows: UsagePaceWindow[] = [];
    for (const name of names) {
      const counted = pool.filter((i) => name in i.used);
      const h = hours(counted);
      if (h < PACE_MIN_HOURS) continue;
      const perHour = counted.reduce((s, i) => s + i.used[name], 0) / h;
      const leftPercent = accounts.reduce((s, a) => {
        const w = a.windows.find((x) => x.name === name);
        return s + (w ? Math.max(0, 100 - w.usedPercent) : 0);
      }, 0);
      windows.push({ name, perHour, leftPercent, hoursLeft: perHour >= 0.05 ? leftPercent / perHour : null });
    }
    if (!windows.length) return { state: 'learning', workerHours: poolHours, needHours: PACE_MIN_HOURS };
    return { state: 'measured', basis, workerHours: poolHours, accounts: accounts.length, windows };
  }

  private persist(): void {
    if (!this.file) return;
    const temp = `${this.file}.${randomUUID()}.tmp`;
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
