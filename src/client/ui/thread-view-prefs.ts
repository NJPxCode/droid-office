// How the Thread view reads: text, spacing, and how much of a worker's tools and thinking shows.
// Saved in this browser (JSON under one key) and applied live to every Thread that is open.

export const THREAD_TEXT_SIZES = ['sm', 'md', 'lg', 'xl'] as const;
export const THREAD_FONTS = ['sans', 'serif', 'mono'] as const;
export const THREAD_SPACINGS = ['compact', 'default', 'relaxed'] as const;
export const THREAD_WIDTHS = ['narrow', 'default', 'wide', 'full'] as const;
export const THREAD_WORK = ['steps', 'fold'] as const;
export const THREAD_TOOLS = ['folded', 'open'] as const;
export const THREAD_THINKING = ['hidden', 'folded', 'open'] as const;

export interface ThreadViewPrefs {
  textSize: (typeof THREAD_TEXT_SIZES)[number];
  font: (typeof THREAD_FONTS)[number];
  spacing: (typeof THREAD_SPACINGS)[number];
  width: (typeof THREAD_WIDTHS)[number];
  /** Whether the tool calls and thoughts between assistant messages show each step or fold into one line. */
  work: (typeof THREAD_WORK)[number];
  tools: (typeof THREAD_TOOLS)[number];
  thinking: (typeof THREAD_THINKING)[number];
}

export const THREAD_VIEW_DEFAULTS: Readonly<ThreadViewPrefs> = Object.freeze({ textSize: 'md', font: 'sans', spacing: 'default', width: 'default', work: 'steps', tools: 'folded', thinking: 'folded' });

const OPTIONS: { [K in keyof ThreadViewPrefs]: readonly ThreadViewPrefs[K][] } = {
  textSize: THREAD_TEXT_SIZES,
  font: THREAD_FONTS,
  spacing: THREAD_SPACINGS,
  width: THREAD_WIDTHS,
  work: THREAD_WORK,
  tools: THREAD_TOOLS,
  thinking: THREAD_THINKING,
};

const storageKey = 'droid-office.thread-view';
const listeners = new Set<(prefs: ThreadViewPrefs) => void>();

/** The saved choices, with anything unknown or invalid back at its default. Accepts the parsed JSON as is, or a partial of it. */
export function normalizeThreadViewPrefs(raw: unknown): ThreadViewPrefs {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const prefs: Record<string, unknown> = { ...THREAD_VIEW_DEFAULTS };
  for (const key of Object.keys(OPTIONS) as (keyof ThreadViewPrefs)[]) {
    const value = src[key];
    if ((OPTIONS[key] as readonly unknown[]).includes(value)) prefs[key] = value;
  }
  return prefs as unknown as ThreadViewPrefs;
}

export const isDefaultThreadViewPrefs = (prefs: ThreadViewPrefs): boolean => (Object.keys(THREAD_VIEW_DEFAULTS) as (keyof ThreadViewPrefs)[]).every((key) => prefs[key] === THREAD_VIEW_DEFAULTS[key]);

const SCALE: Record<ThreadViewPrefs['textSize'], string> = { sm: '0.93', md: '1', lg: '1.14', xl: '1.29' };
const FONT: Record<ThreadViewPrefs['font'], string> = { sans: 'var(--font-sans)', serif: "ui-serif, Georgia, 'Times New Roman', serif", mono: 'var(--font-mono)' };
const GAP: Record<ThreadViewPrefs['spacing'], string> = { compact: 'var(--space-3)', default: 'var(--space-5)', relaxed: 'var(--space-7)' };
const LEADING: Record<ThreadViewPrefs['spacing'], string> = { compact: '1.55', default: '1.725', relaxed: '1.9' };
// Full width is a viewport-wide cap rather than `none`, which `min()` in the pinned message's width can't take.
const MEASURE: Record<ThreadViewPrefs['width'], string> = { narrow: '640px', default: '768px', wide: '960px', full: '100vw' };

/** The CSS variables a `.worker-thread` root takes for these choices. */
export function threadViewVars(prefs: ThreadViewPrefs): Record<string, string> {
  return {
    '--wt-text-scale': SCALE[prefs.textSize],
    '--wt-prose-font': FONT[prefs.font],
    '--wt-entry-gap': GAP[prefs.spacing],
    '--wt-prose-leading': LEADING[prefs.spacing],
    '--wt-measure': MEASURE[prefs.width],
  };
}

/** What the choices that change how a row is built come to; a row painted under another key is painted again. */
export const threadViewRowKey = (prefs: ThreadViewPrefs): string => `${prefs.work}:${prefs.tools}:${prefs.thinking}`;

const same = (a: ThreadViewPrefs, b: ThreadViewPrefs) => (Object.keys(OPTIONS) as (keyof ThreadViewPrefs)[]).every((key) => a[key] === b[key]);

let current: ThreadViewPrefs | undefined;
let watching = false;

function read(): ThreadViewPrefs {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved !== null) return normalizeThreadViewPrefs(JSON.parse(saved));
  } catch {
    // storage blocked or unreadable
  }
  return { ...THREAD_VIEW_DEFAULTS };
}

function announce(next: ThreadViewPrefs) {
  current = next;
  for (const fn of listeners) fn(next);
}

/** Another tab saved a change: apply it here too. */
function watchStorage() {
  if (watching) return;
  watching = true;
  try {
    window.addEventListener('storage', (event) => {
      if (event.key !== null && event.key !== storageKey) return;
      const next = read();
      if (!same(next, threadViewPrefs())) announce(next);
    });
  } catch {
    // no window here
  }
}

/** The saved choices, else the defaults. */
export function threadViewPrefs(): ThreadViewPrefs {
  current ??= read();
  return current;
}

function save(next: ThreadViewPrefs) {
  try {
    if (isDefaultThreadViewPrefs(next)) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    // storage blocked
  }
  announce(next);
}

/** Changes some of the choices. Anything invalid in `patch` is ignored. */
export function setThreadViewPrefs(patch: Partial<ThreadViewPrefs>) {
  const next = normalizeThreadViewPrefs({ ...threadViewPrefs(), ...patch });
  if (!same(next, threadViewPrefs())) save(next);
}

export function resetThreadViewPrefs() {
  if (!same(threadViewPrefs(), THREAD_VIEW_DEFAULTS)) save({ ...THREAD_VIEW_DEFAULTS });
}

/** Hears every change of the choices, from here or another tab; returns the unlisten. */
export function onThreadViewPrefs(fn: (prefs: ThreadViewPrefs) => void): () => void {
  watchStorage();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
