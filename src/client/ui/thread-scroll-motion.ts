const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Transcript motion: following the bottom as it grows, and a 180 ms ease-out jump to it. */
export class ThreadScrollMotion {
  private frame = 0;
  private generation = 0;

  constructor(
    private readonly scroll: HTMLElement,
    private readonly settled: () => void,
  ) {}

  cancel() {
    this.generation++;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  snap() {
    this.cancel();
    this.scroll.scrollTop = this.scroll.scrollHeight;
    this.settled();
  }

  /**
   * Keeps the bottom in view as the transcript grows, in the same frame: the newest line never trails a
   * paint behind. A jump to the bottom still easing in is left to land, since it aims at the bottom as it goes.
   */
  follow() {
    if (this.frame) return;
    this.scroll.scrollTop = this.scroll.scrollHeight;
    this.settled();
  }

  quick() {
    if (reduced()) return this.snap();
    this.cancel();
    const generation = this.generation;
    const from = this.scroll.scrollTop;
    const started = performance.now();
    const step = (now: number) => {
      if (generation !== this.generation) return;
      const t = Math.min(1, (now - started) / 180);
      const target = this.scroll.scrollHeight - this.scroll.clientHeight;
      this.scroll.scrollTop = from + (target - from) * (1 - (1 - t) ** 3);
      if (t >= 1) {
        this.scroll.scrollTop = this.scroll.scrollHeight;
        this.frame = 0;
        this.settled();
        return;
      }
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  dispose() {
    this.cancel();
  }
}
