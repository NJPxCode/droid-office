/**
 * Droid's slash commands in the Thread view. Built-in Thread/RPC commands are listed here:
 * session compaction (`/compress`, `/compact`), `/handoff`, `/clear`, `/new`, native `/copy` and
 * `/limits` sheets, and blocked CLI exit (`/quit`, `/exit` — Send home is how a worker leaves).
 * `midTurn` marks commands that can open while a turn runs without stopping the turn.
 *
 * The worker's skills and custom commands come from its own droid (`daemon.list_skills` and
 * `daemon.list_commands`, served at GET /api/agents/droid/commands?worker=). They run as prompts
 * in the Thread view.
 *
 * The Android app has the same built-in list (core/SlashCommands.kt), checked by tests/slash-commands.test.ts.
 */

export type SlashKind = 'thread' | 'blocked';

export interface SlashCommand {
  name: string;
  description: string;
  kind: SlashKind;
  aliases?: readonly string[];
  /** Where a command that isn't built in comes from: one of the worker's skills, or a custom command. */
  source?: DroidSlashCommand['source'];
  /** What to type after the name, as the command describes it. */
  argumentHint?: string;
  /** Runs during a turn without stopping the turn. */
  midTurn?: boolean;
}

/** A skill or custom command a worker's droid offers, as GET /api/agents/droid/commands lists it. */
export interface DroidSlashCommand {
  name: string;
  description: string;
  source: 'skill' | 'command';
  argumentHint?: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'compress', aliases: ['compact'], description: 'Compress the session in place. Add instructions to shape the summary', kind: 'thread' },
  { name: 'clear', description: 'Clear the conversation, keeping the model', kind: 'thread' },
  { name: 'new', description: 'Start a fresh session with the default model', kind: 'thread' },
  { name: 'handoff', description: 'Start a new session with a summary of this one', kind: 'thread' },
  { name: 'copy', description: 'Copy a reply, a prompt, a range of turns, the transcript or the session id', kind: 'thread', midTurn: true },
  { name: 'limits', description: 'Manage credit limits and overage', kind: 'thread', midTurn: true },
  { name: 'quit', aliases: ['exit'], description: 'Ends this worker’s Droid. Use Send home instead', kind: 'blocked' },
];

/**
 * Every slash command a worker offers: the built-in ones, then its droid's custom commands and
 * skills. One named like a built-in command (or its alias) is left out, since Droid runs the built-in.
 */
export function slashCommands(live: readonly DroidSlashCommand[] = []): SlashCommand[] {
  const taken = new Set(SLASH_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
  const extra: SlashCommand[] = [];
  for (const c of live) {
    if (typeof c?.name !== 'string' || typeof c.description !== 'string' || (c.source !== 'skill' && c.source !== 'command')) continue;
    const name = c.name.toLowerCase();
    if (taken.has(name)) continue;
    taken.add(name);
    extra.push({ name: c.name, description: c.description, kind: 'thread', source: c.source, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) });
  }
  return [...SLASH_COMMANDS, ...extra];
}

/** What a draft that starts with `/` asks for: the command's name as typed, and the command when the list has it. */
export function slashOf(draft: string, commands: readonly SlashCommand[] = SLASH_COMMANDS): { name: string; command?: SlashCommand } | undefined {
  const m = /^\/([^\s/]*)(?=\s|$)/.exec(draft.trimStart());
  if (!m) return undefined;
  const name = m[1].toLowerCase();
  return { name, command: commands.find((c) => c.name.toLowerCase() === name || c.aliases?.includes(name)) };
}

/** What a slash draft does when sent: run in the thread, or nothing when blocked. A plain message is 'thread'. */
export function slashKind(draft: string): SlashKind {
  return slashOf(draft)?.command?.kind ?? 'thread';
}

/** Connected offices show their own limits window, even when Factory cannot report quota windows. */
export function nativeLimits(draft: string, factoryConnected: boolean): boolean {
  return factoryConnected && slashOf(draft)?.command?.name === 'limits';
}

/** `/copy` (optionally with a turn count) opens the Thread's own copy choices instead of sending a prompt. */
export function nativeCopy(draft: string): boolean {
  return slashOf(draft)?.command?.name === 'copy';
}

/** The initial turn count for the native copy dialog, matching Android. */
export function copyTurns(draft: string): string {
  const text = draft.trim();
  const separator = text.indexOf(' ');
  return separator < 0
    ? '1'
    : text
        .slice(separator + 1)
        .replace(/[^\p{Nd}]/gu, '')
        .slice(0, 4) || '1';
}

/**
 * Why a slash draft can't be sent now, or undefined when it can: a command that would end the CLI
 * never, and while a turn runs only those marked `midTurn`.
 */
export function slashRefusal(draft: string, name: string, busy: boolean, commands: readonly SlashCommand[] = SLASH_COMMANDS): string | undefined {
  const slash = slashOf(draft, commands);
  if (!slash) return undefined;
  if (slash.command?.kind === 'blocked') return `/${slash.name} would end ${name}’s Droid. Send it home instead.`;
  if (busy && !slash.command?.midTurn) return `/${slash.name} runs once ${name} finishes this turn. Stop it to run it now.`;
  return undefined;
}

/**
 * The commands to offer while the owner types one: only while the draft is a `/` and the start of a
 * name, with no space yet. Names that start with what's typed come first, then aliases, then names
 * that contain it.
 */
export function slashSuggestions(draft: string, commands: readonly SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  const m = /^\/([^\s/]*)$/.exec(draft.trimStart());
  if (!m) return [];
  const typed = m[1].toLowerCase();
  const rank = (c: SlashCommand) => {
    const name = c.name.toLowerCase();
    return name.startsWith(typed) ? 0 : c.aliases?.some((a) => a.startsWith(typed)) ? 1 : name.includes(typed) ? 2 : -1;
  };
  return commands
    .map((c, i) => ({ c, r: rank(c), i }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}
