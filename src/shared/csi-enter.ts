/**
 * Modified Enter as native terminals send it: CSI u sequences. The old Droid TUI accepted them
 * without Kitty keyboard negotiation; daemon-backed Threads submit prompts through RPCs instead.
 * A plain shell that has not requested CSI u should not get this fallback.
 */

import type { WorkerInfo } from './protocol.js';

export const CTRL_ENTER = '\x1b[13;5u';
export const SHIFT_ENTER = '\x1b[13;2u';

/** Legacy Droid capability flag. Explicit shell desks rely on keyboard protocol negotiation. */
export function wantsCsiEnter(kind: WorkerInfo['kind'] | undefined): boolean {
  return kind === 'agent';
}

export interface KeyMods {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

/** The bytes Enter with these modifiers should send, or undefined for the terminal's default. */
export function modifiedEnter(csiEnter: boolean, mods: KeyMods): string | undefined {
  if (!csiEnter || mods.alt || mods.meta) return undefined;
  if (mods.ctrl && !mods.shift) return CTRL_ENTER;
  if (mods.shift && !mods.ctrl) return SHIFT_ENTER;
  return undefined;
}

/** The slice of a KeyboardEvent the terminal's key handler reads. */
export interface KeyEventLike {
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
}

export type KeyAction = { do: 'send'; data: string } | { do: 'swallow' } | { do: 'default' };

/**
 * What xterm.js's custom key handler should do with a key event: `send` the replacement bytes
 * (on keydown), `swallow` it (the keypress/keyup of a replaced Enter, so xterm doesn't add its
 * own CR), or `default` to let xterm handle it.
 */
export function enterKeyAction(csiEnter: boolean, e: KeyEventLike): KeyAction {
  // Enter while an IME is composing commits the composition; it isn't a keystroke for the PTY.
  if (e.key !== 'Enter' || e.isComposing) return { do: 'default' };
  const data = modifiedEnter(csiEnter, { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
  if (data === undefined) return { do: 'default' };
  return e.type === 'keydown' ? { do: 'send', data } : { do: 'swallow' };
}
