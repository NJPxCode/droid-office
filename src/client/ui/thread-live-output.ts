// Live boxes (running command output, live thinking) that follow their newest line while they grow.

/** How long after the owner's wheel, touch, pointer or key a scroll counts as theirs. */
const OWNER_SCROLL_MS = 400;

/** Makes `box` follow its tail until the owner scrolls up inside it, and again once they return to the end. */
export function followsTail<T extends HTMLElement>(box: T): T {
  let ownerAt = -Infinity;
  const owner = () => {
    ownerAt = performance.now();
  };
  box.addEventListener('wheel', owner, { passive: true });
  box.addEventListener('touchmove', owner, { passive: true });
  box.addEventListener('pointerdown', owner);
  box.addEventListener('keydown', owner);
  let last = 0;
  box.addEventListener('scroll', () => {
    const delta = box.scrollTop - last;
    last = box.scrollTop;
    const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
    if (performance.now() - ownerAt < OWNER_SCROLL_MS && delta < -1 && distance > 1) box.dataset.tail = 'off';
    else if (distance <= 8) delete box.dataset.tail;
  });
  return box;
}

/** Scrolls a `followsTail` box to its newest line unless the owner has scrolled it up. */
export function keepAtTail(box: HTMLElement): void {
  if (box.dataset.tail !== 'off') box.scrollTop = box.scrollHeight;
}
