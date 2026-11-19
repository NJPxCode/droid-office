// How a live stream's thinking or reply text shows up: word by word at a steady pace, however it arrives.

/** Text shows at most about this long after it arrives, in milliseconds. */
export const REVEAL_LAG_MS = 350;
/** A burst also gets this long per character to show in, so it rolls out rather than landing at once. */
export const REVEAL_BURST_CPS = 1200;
/** However big the burst, it shows within this long of arriving, in milliseconds. */
export const REVEAL_MAX_LAG_MS = 1000;
/** Slowest reveal while text is waiting, in characters a second. */
export const REVEAL_MIN_CPS = 60;
/** Once the stream has ended, what is left shows within about this long, in milliseconds. */
export const REVEAL_END_MS = 200;
/** A stream first seen this long after it started (a Thread opened mid-reply) shows what it has at once. */
export const REVEAL_JOIN_AGE_MS = 1500;
/** A word still being written shows after waiting this long for the rest of it, in milliseconds. */
export const REVEAL_PARTIAL_MS = 120;

const space = (c: string | undefined) => c === ' ' || c === '\n' || c === '\t' || c === '\r';

/**
 * The revealed length of one live stream, advanced each frame. Each piece of text that arrives gets a
 * deadline (REVEAL_LAG_MS, plus time for a burst's size, capped at REVEAL_MAX_LAG_MS), and the reveal runs
 * just fast enough to meet the nearest one, so a steady stream shows at its own pace and a burst rolls
 * out over a fraction of a second. Ends on a word boundary, except for a last word left waiting past
 * REVEAL_PARTIAL_MS.
 */
export class StreamReveal {
  private key = '';
  private text = '';
  private clock = 0;
  private budget = 0;
  private waited = 0;
  /** Where each arrival ends and when it must be showing, oldest first. */
  private due: { end: number; by: number }[] = [];
  private arrivedAt = -1;
  /** The usual time between arrivals, smoothed. */
  private gap = 0;
  private endBy: number | undefined;
  shown = 0;

  /** Whether there is text still to show. */
  get pending(): boolean {
    return this.shown < this.text.length;
  }

  /**
   * The length of `text` to show after `dtMs` more of revealing it. A new `key` is a new stream: with
   * `join` (the reader arrived after it began) what it already has shows at once. `ended` finishes it.
   */
  advance(key: string, text: string, dtMs: number, opts: { join?: boolean; ended?: boolean } = {}): number {
    const dt = Math.min(100, Math.max(0, dtMs));
    this.clock += dt;
    if (key !== this.key) {
      this.key = key;
      this.text = '';
      this.shown = 0;
      this.budget = 0;
      this.waited = 0;
      this.due = [];
      this.arrivedAt = -1;
      this.gap = 0;
      this.endBy = undefined;
      if (opts.join) this.shown = text.length;
    } else if (!text.startsWith(this.text.slice(0, this.shown))) {
      // Rewritten under it (a long stream trimmed at its start): show it whole rather than start over.
      this.shown = text.length;
      this.due = [];
    }
    if (text.length > this.text.length && text.length > this.shown) {
      const size = text.length - Math.max(this.text.length, this.shown);
      // Text that comes in spaced-out pieces spreads over the gap between them instead of waiting at each.
      const gap = this.clock - this.arrivedAt;
      if (this.arrivedAt >= 0 && gap > 0 && gap < REVEAL_MAX_LAG_MS) this.gap = this.gap ? this.gap * 0.7 + gap * 0.3 : gap;
      this.arrivedAt = this.clock;
      const lag = Math.min(REVEAL_MAX_LAG_MS, Math.max(REVEAL_LAG_MS, this.gap * 1.2));
      // Queued behind what is still showing, so a burst's backlog never hurries the text after it.
      const after = Math.max(this.clock + lag, this.due.at(-1)?.by ?? 0);
      this.due.push({ end: text.length, by: Math.min(this.clock + REVEAL_MAX_LAG_MS, after + (size * 1000) / REVEAL_BURST_CPS) });
    }
    this.text = text;
    while (this.due.length && this.due[0].end <= this.shown) this.due.shift();
    if (this.shown >= text.length) {
      this.shown = text.length;
      this.budget = 0;
      this.waited = 0;
      return this.shown;
    }
    if (!dt) return this.shown;
    let perMs = REVEAL_MIN_CPS / 1000;
    for (const d of this.due) perMs = Math.max(perMs, (d.end - this.shown) / Math.max(dt, d.by - this.clock));
    if (opts.ended) {
      this.endBy ??= this.clock + REVEAL_END_MS;
      perMs = Math.max(perMs, (text.length - this.shown) / Math.max(dt, this.endBy - this.clock));
    }
    // Whole words end here: a last word may still be arriving, so it waits for its space.
    const whole = opts.ended || space(text[text.length - 1]) ? text.length : lastBoundary(text, text.length);
    if (this.shown >= whole) {
      this.budget = 0;
      this.waited += dt;
      if (this.waited >= REVEAL_PARTIAL_MS) {
        this.shown = text.length;
        this.waited = 0;
      }
      return this.shown;
    }
    this.waited = 0;
    this.budget += perMs * dt;
    // A word shows whole once its turn comes, and the words after it wait off what it overdrew.
    if (this.budget >= 1) {
      const end = Math.min(whole, wordEnd(text, this.shown + Math.floor(this.budget)));
      this.budget -= end - this.shown;
      this.shown = end;
    }
    return this.shown;
  }

  reset(): void {
    this.key = '';
    this.text = '';
    this.shown = 0;
    this.budget = 0;
    this.waited = 0;
    this.due = [];
    this.arrivedAt = -1;
    this.gap = 0;
    this.endBy = undefined;
  }
}

/** `at`, moved on to the end of the word it falls in (past the spaces after it). */
function wordEnd(text: string, at: number): number {
  let i = Math.max(0, Math.min(text.length, at));
  while (i < text.length && !space(text[i])) i++;
  while (i < text.length && space(text[i])) i++;
  return i;
}

/** Where the last word before `end` starts: just past the last space before it, or 0. */
function lastBoundary(text: string, end: number): number {
  let i = end;
  while (i > 0 && !space(text[i - 1])) i--;
  return i;
}
