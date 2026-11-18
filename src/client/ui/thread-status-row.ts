import { statusElapsed, type ThreadStatus } from '../../shared/thread-status';
import { h } from './dom';

/** One announcement per phase; the visible clock updates without announcing every second. */
export function mountThreadStatusRow() {
  const label = h('span.wt-progress-label', { role: 'status' });
  const elapsed = h('span.wt-progress-elapsed', { 'aria-hidden': 'true', hidden: true });
  const detail = h('span.wt-progress-detail', { hidden: true });
  const element = h('div.wt-progress', { hidden: true }, h('div.wt-progress-line', {}, h('span.wt-progress-glyph', { 'aria-hidden': 'true' }), label, elapsed, detail));
  let since: number | undefined;
  let timer = 0;

  const tick = () => {
    window.clearTimeout(timer);
    timer = 0;
    elapsed.hidden = since === undefined;
    if (since === undefined || document.hidden) return;
    const now = Date.now();
    const text = `· ${statusElapsed(since, now)}`;
    if (elapsed.textContent !== text) elapsed.textContent = text;
    timer = window.setTimeout(tick, 1000 - (Math.max(0, now - since) % 1000));
  };
  document.addEventListener('visibilitychange', tick);

  return {
    element,
    paint(status: ThreadStatus | undefined) {
      element.hidden = !status;
      element.classList.toggle('running', !!status && !status.waiting);
      const title = status?.label ?? '';
      if (label.textContent !== title) {
        label.textContent = title;
        label.title = title;
      }
      const note = status?.detail ?? '';
      if (detail.textContent !== note) {
        detail.textContent = note;
        detail.title = note;
      }
      detail.hidden = !note;
      if (since !== status?.since) {
        since = status?.since;
        tick();
      }
    },
    dispose() {
      document.removeEventListener('visibilitychange', tick);
      window.clearTimeout(timer);
      element.hidden = true;
    },
  };
}
