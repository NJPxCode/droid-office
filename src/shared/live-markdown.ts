// Where a Markdown reply still being written can be split, so a live Thread renders only its last block again.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A line that can only start a new top-level block: not indented, and not a list item, quote or table row that may carry on one before it. */
const FRESH = (line: string) => !/^\s/.test(line) && !/^([-*+]|\d{1,9}[.)])(\s|$)/.test(line) && !/^[>|]/.test(line) && !/^\$\$/.test(line);

/** A line still arriving that already shows it starts a fresh block: a letter cannot open a list, quote, table or indent. */
const FRESH_START = /^\p{L}/u;

/**
 * The length of `text` whose Markdown renders the same whatever is written after it: up to the start of
 * the last fresh top-level block after a blank line, outside code fences. The last line may still be
 * arriving, so it counts only once its start rules out carrying on the block before it. 0 when there is
 * no such point yet.
 */
export function settledMarkdownEnd(text: string): number {
  let fence: string | undefined;
  let blank = false;
  let end = 0;
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl < 0) return !fence && blank && FRESH_START.test(text.slice(start)) ? start : end;
    const line = text.slice(start, nl);
    const open = FENCE.exec(line);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !line.slice(open[0].length).trim()) fence = undefined;
    } else if (!line.trim()) {
      blank = true;
    } else {
      if (blank && FRESH(line)) end = start;
      blank = false;
      if (open) fence = open[1];
    }
    start = nl + 1;
  }
}
