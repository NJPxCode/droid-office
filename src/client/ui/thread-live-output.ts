// Live boxes (running command output, live thinking, the live reply) and how they hand over to what replaces them.

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

/** How far into `root`'s text the point `node`/`offset` falls. */
function textOffset(root: Node, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** The text node and offset `at` characters into `root`'s text. */
function pointAt(root: Node, at: number): [Node, number] | undefined {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let left = at;
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (left <= length) return [node, left];
    left -= length;
  }
  return undefined;
}

/** Captures a reply selection before its DOM changes; restores it onto the same rendered text. */
export function rememberSelection(from: Element | null | undefined): ((targets: () => Element[]) => void) | undefined {
  if (!from) return;
  const selection = from.ownerDocument.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (!from.contains(range.startContainer) || !from.contains(range.endContainer)) return;
  const picked = range.toString();
  if (!picked) return;
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  const backward = anchorNode === range.endContainer && anchorOffset === range.endOffset;
  const start = textOffset(from, range.startContainer, range.startOffset);
  return (targets) => {
    const candidates = targets();
    // Leave a selection in untouched settled blocks alone.
    if (candidates.includes(from) && selection.anchorNode === anchorNode && selection.anchorOffset === anchorOffset && selection.focusNode === focusNode && selection.focusOffset === focusOffset) return;
    const target = candidates.findLast((el) => el.textContent?.includes(picked));
    if (!target) return;
    const text = target.textContent ?? '';
    let best = start;
    if (!text.startsWith(picked, start)) {
      best = -1;
      for (let at = text.indexOf(picked); at >= 0; at = text.indexOf(picked, at + 1)) {
        if (best < 0 || Math.abs(at - start) < Math.abs(best - start)) best = at;
        if (at > start) break;
      }
    }
    const head = pointAt(target, best);
    const tail = pointAt(target, best + picked.length);
    if (head && tail) selection.setBaseAndExtent(...(backward ? tail : head), ...(backward ? head : tail));
  };
}
