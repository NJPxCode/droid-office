// Droid 1.12's /rewind-conversation screens. Pure parsing, checked against a real capture in
// tests/thread-rewind.test.ts; the terminal driving lives in src/server/worker-rewind.ts.

export interface RewindMenuRow {
  /** Droid's message number (the JSONL seq + 1), newest first. */
  number: number;
  preview: string;
  selected: boolean;
}

export interface RewindMenu {
  rows: RewindMenuRow[];
  empty: boolean;
  total?: number;
}

export interface RewindRestoreOption {
  label: string;
  selected: boolean;
}

const cell = (line: string) => {
  const start = line.indexOf('│');
  const end = line.lastIndexOf('│');
  return start >= 0 && end > start ? line.slice(start + 1, end) : '';
};

/** The user-message picker, or undefined while another screen is showing. */
export function readRewindMenu(lines: readonly string[]): RewindMenu | undefined {
  if (!lines.some((line) => cell(line).includes('Select a user message to rewind before'))) return undefined;
  const rows: RewindMenuRow[] = [];
  let empty = false;
  let total: number | undefined;
  for (const line of lines) {
    const text = cell(line) || line;
    if (text.includes('No previous user messages available for rewind.')) empty = true;
    const row = /^\s*([> ])\s*(\d+)\s+(.+?)\s*$/.exec(text);
    if (row) rows.push({ number: Number(row[2]), preview: row[3], selected: row[1] === '>' });
    const showing = /Showing\s+\d+-\d+\s+of\s+(\d+)/.exec(text);
    if (showing) total = Number(showing[1]);
  }
  return { rows, empty, ...(total !== undefined ? { total } : {}) };
}

/** The file-restoration choices, in the order Droid shows them. */
export function readRewindRestore(lines: readonly string[]): RewindRestoreOption[] | undefined {
  if (!lines.some((line) => cell(line).includes('Rewind File Restoration'))) return undefined;
  const options: RewindRestoreOption[] = [];
  for (const line of lines) {
    const text = cell(line);
    const match = /^\s*([> ])\s*(Restore all files|Choose files to restore\.\.\.|Don't restore files)\s*$/.exec(text);
    if (match) options.push({ label: match[2], selected: match[1] === '>' });
  }
  return options;
}

/** Whether this rewind point has no files to restore and Esc continues conversation-only. */
export function rewindWithoutFiles(lines: readonly string[]): boolean {
  return lines.some((line) => cell(line).includes('No file changes found for this rewind point')) && lines.some((line) => /Press Esc to continue without restoration/.test(cell(line) || line));
}

export function rewound(lines: readonly string[]): boolean {
  return lines.some((line) => /●\s+Rewound conversation to before:/.test(line));
}

/** Droid's status while it forks and restores the selected rewind point. */
export function rewindProcessing(lines: readonly string[]): boolean {
  return lines.some((line) => line.includes('(Please wait)'));
}
