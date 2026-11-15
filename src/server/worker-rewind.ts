import { readRewindMenu, readRewindRestore, rewindWithoutFiles, rewound, type RewindMenu } from '../shared/thread-rewind.js';
import { textSignature } from '../shared/thread-live.js';

export interface RewindDriveTarget {
  /** Droid's menu number (JSONL seq + 1), so equal prompts stay distinguishable. */
  number: number;
  preview: string;
}

export interface RewindDriveResult {
  ok: boolean;
  error?: string;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const DOWN = '\x1b[B';
const UP = '\x1b[A';
const ESC = '\x1b';

function samePreview(shown: string, text: string): boolean {
  const a = textSignature(shown);
  const b = textSignature(text);
  return !!a && !!b && (b.startsWith(a) || a.startsWith(b.slice(0, 60)));
}

/**
 * Drives Droid's own rewind menu, never editing its conversation files. The caller has already made
 * sure the worker is idle and resolved the user entry to its menu number and preview.
 */
export async function driveDroidRewind(io: { write(data: string): void; rows(): readonly string[] | undefined }, target: RewindDriveTarget, restore: 'files' | 'conversation'): Promise<RewindDriveResult> {
  const rows = () => io.rows() ?? [];
  const fail = async (error: string): Promise<RewindDriveResult> => {
    io.write(ESC);
    await pause(60);
    io.write('\x15');
    return { ok: false, error };
  };

  // Ctrl+U clears a draft so the slash command cannot be appended to it.
  io.write('\x15');
  await pause(40);
  io.write('/rewind-conversation');
  await pause(80);
  io.write('\r');

  let menu: RewindMenu | undefined;
  for (let attempt = 0; attempt < 50 && !menu; attempt++) {
    await pause(40);
    menu = readRewindMenu(rows());
  }
  if (!menu) return fail('Droid did not open its rewind menu.');
  if (menu.empty) return fail('Droid has no previous user messages to rewind to.');

  // Selection starts on the newest message. Rows scroll as the selection moves, so match again
  // after every key rather than trusting the first two visible rows.
  let previous = '';
  let chosen = false;
  const visited = new Set<number>();
  for (;;) {
    const current = rows();
    menu = readRewindMenu(current);
    if (!menu) return fail('Droid closed its rewind menu before a message was selected.');
    const numbered = menu.rows.find((row) => row.number === target.number);
    if (numbered && !samePreview(numbered.preview, target.preview)) return fail('The active conversation changed. Read the Thread again before rewinding.');
    const index = numbered ? menu.rows.indexOf(numbered) : -1;
    const selected = menu.rows.findIndex((row) => row.selected);
    const currentNumber = menu.rows[selected]?.number;
    if (currentNumber === undefined || visited.has(currentNumber)) return fail('The requested message is not in Droid’s rewind menu.');
    visited.add(currentNumber);
    if (index >= 0) {
      if (selected === index) {
        chosen = true;
        break;
      }
      io.write(index > selected ? DOWN : UP);
    } else {
      io.write(target.number < currentNumber ? DOWN : UP);
    }
    await pause(55);
    const signature = rows().join('\n');
    if (signature === previous) return fail('The requested message is not in Droid’s rewind menu.');
    previous = signature;
  }
  if (!chosen) return fail('The requested message is not in Droid’s rewind menu.');
  io.write('\r');

  let restored = restore === 'conversation';
  for (let attempt = 0; attempt < 100; attempt++) {
    await pause(50);
    const current = rows();
    if (rewound(current)) {
      // Droid puts the rewound prompt back in its input; the client prefills its own composer.
      io.write('\x15');
      return { ok: true };
    }
    if (rewindWithoutFiles(current)) {
      io.write(ESC);
      continue;
    }
    const options = readRewindRestore(current);
    if (!options) continue;
    const label = restore === 'files' ? 'Restore all files' : "Don't restore files";
    const wanted = options.findIndex((option) => option.label === label);
    const selected = options.findIndex((option) => option.selected);
    if (wanted < 0 || selected < 0) return fail('Droid did not offer the requested rewind restoration.');
    if (wanted === selected) {
      io.write('\r');
      restored = true;
    } else io.write(wanted > selected ? DOWN : UP);
  }
  return fail(restored ? 'Droid did not finish rewinding its conversation.' : 'Droid did not finish restoring the rewind point.');
}
