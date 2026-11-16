// Public model benchmarks from Artificial Analysis (artificialanalysis.ai), so leads picking a model see
// how capable each one is and what a task costs at each reasoning effort (docs/subscriptions.md#benchmarks).

import { AGENT_EFFORTS, type AgentEffort } from './protocol.js';

export const ARTIFICIAL_ANALYSIS_URL = 'https://artificialanalysis.ai';
export const ARTIFICIAL_ANALYSIS_KEYS_URL = 'https://artificialanalysis.ai/api-key-management-redirect';

/** A reasoning setting Artificial Analysis names in parentheses: Droid's efforts, or reasoning on or off. */
export type BenchmarkEffort = AgentEffort | 'reasoning' | 'non-reasoning';

/** One reasoning effort of a model as Artificial Analysis measured it; nulls are "not measured". */
export interface BenchmarkVariant {
  /** Undefined for a model measured at one setting only. */
  effort?: BenchmarkEffort;
  /** Artificial Analysis Intelligence Index (0–100). */
  intelligence: number | null;
  /** Artificial Analysis Engineering capability index (0–100). */
  engineering: number | null;
  /** US dollars per Intelligence Index task at the creator's API prices (tokens spent times price), not plan quota. */
  costPerTask: number | null;
  /** Mean output tokens per second on the creator's API. */
  tokensPerSecond: number | null;
}

/** A model family as Artificial Analysis names it ("Claude Opus 5.5"), with each effort it measured. */
export interface BenchmarkModel {
  name: string;
  variants: BenchmarkVariant[];
}

/** The office's Artificial Analysis connection, as clients see it (the key never leaves the server). */
export interface BenchmarksState {
  connected: boolean;
  /** The key's last four characters. */
  fingerprint?: string;
  /** When it was connected, ms since the epoch. */
  at?: number;
  /** When the benchmarks were last read. */
  fetchedAt?: number;
  /** How many model families were read. */
  models: number;
  /** A read is under way. */
  checking?: boolean;
  /** Why the last read failed; the benchmarks from before stay in use. */
  error?: string;
}

export function emptyBenchmarksState(): BenchmarksState {
  return { connected: false, models: 0 };
}

const EFFORT_WORDS: Record<string, BenchmarkEffort> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  reasoning: 'reasoning',
  'non-reasoning': 'non-reasoning',
};

/** "Claude Opus 5.5 (High, Default Fallback)" is Claude Opus 5.5 at high; "Gemini 1.5 Pro (Sep '24)" is a name of its own. */
export function benchmarkName(name: string): { base: string; effort?: BenchmarkEffort } {
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(name);
  const first = m?.[2].split(',')[0].trim().toLowerCase();
  const effort = first !== undefined ? EFFORT_WORDS[first] : undefined;
  return m && effort ? { base: m[1], effort } : { base: name.trim() };
}

/** Brand words a name may or may not lead with: "Claude Opus 5.5" is Droid's "Opus 5.5". */
const BRANDS = new Set(['claude', 'anthropic', 'openai', 'google', 'xai', 'meta']);

/** "DroidProxy: GPT 6.1 Sol", "GPT-6.1 Sol" and "DroidProxy: Antigravity: GPT 6.1 Sol (High)" all read gpt 6.1 sol. */
export function nameKey(name: string): string {
  const words = benchmarkName(name.replace(/^(?:[^:]*:\s*)+/, ''))
    .base.toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length > 2 && BRANDS.has(words[0])) words.shift();
  return words.join(' ');
}

/** The benchmarks for a Droid model by its display name; undefined when Artificial Analysis has no model of that name. */
export function matchBenchmark(displayName: string, models: readonly BenchmarkModel[]): BenchmarkModel | undefined {
  const key = nameKey(displayName);
  return key ? models.find((m) => nameKey(m.name) === key) : undefined;
}

const score = (n: number | null) => (n === null ? '?' : String(Math.round(n * 10) / 10));
const dollars = (n: number | null) => (n === null ? '$?' : n < 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(n < 10 ? 2 : 1)}`);
const variantWords = (v: BenchmarkVariant) => `intelligence ${score(v.intelligence)}, engineering ${score(v.engineering)}, ${dollars(v.costPerTask)}/task`;

/**
 * "medium (default): intelligence 48.2, engineering 53.7, $2.45/task; low: …; high: …". Efforts the
 * model takes, in order, default first; a model measured at one unnamed setting prints just its numbers.
 */
export function benchmarkWords(m: BenchmarkModel, efforts?: readonly string[], defaultEffort?: string): string {
  if (m.variants.length === 1 && !m.variants[0].effort) return variantWords(m.variants[0]);
  const order: string[] = [...AGENT_EFFORTS, 'reasoning', 'non-reasoning'];
  const rank = (v: BenchmarkVariant) => (v.effort ? order.indexOf(v.effort) : -1);
  const taken = m.variants.filter((v) => v.effort && (!efforts?.length || efforts.includes(v.effort)));
  const shown = (taken.length ? taken : m.variants).sort((a, b) => Number(b.effort === defaultEffort) - Number(a.effort === defaultEffort) || rank(a) - rank(b));
  return shown.map((v) => `${v.effort ?? 'default'}${v.effort && v.effort === defaultEffort ? ' (default)' : ''}: ${variantWords(v)}`).join('; ');
}
