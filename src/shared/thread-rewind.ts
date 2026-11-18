import { extractThreadChanges } from './thread-diff.js';

import type { ThreadEntry } from './worker-thread.js';
/** A file the conversation changed after a user message: a rewind to before it restores or deletes it. */
export interface RewindFile {
  path: string;
  shortPath: string;
  action: 'restore' | 'delete';
}

/** The files changed after the user message `entryId`, as Droid's "Choose files to restore..." lists them. */
export function rewindFilesSince(entries: readonly ThreadEntry[], entryId: string): RewindFile[] {
  const at = entries.findIndex((entry) => entry.id === entryId);
  if (at < 0) return [];
  const files = new Map<string, RewindFile>();
  for (const entry of entries.slice(at + 1)) {
    if (entry.error) continue;
    for (const change of extractThreadChanges(entry) ?? []) {
      // A file created after the message is deleted by the rewind, however often it was edited later.
      const action = files.get(change.path)?.action ?? (change.kind === 'added' ? 'delete' : 'restore');
      files.set(change.path, { path: change.path, shortPath: change.shortPath, action });
    }
  }
  return [...files.values()];
}
