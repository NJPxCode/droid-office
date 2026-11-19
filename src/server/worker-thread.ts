import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, readFile, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { editedFilePaths } from '../shared/thread-diff.js';
import { thinkingDuration } from '../shared/thread-live.js';
import { IMAGE_PLACEHOLDER, pageRows, presentThread, THREAD_MODEL_VERSION, type ThreadFileText, type ThreadPresentation, type ThreadRow } from '../shared/thread-presentation.js';
import type { ThreadEntry, ThreadImage } from '../shared/worker-thread.js';
import { LABEL_TEXT_CHARS } from '../shared/worker-labels.js';
import { hideOfficeText, isThreadSystemMessage, OFFICE_SAYS } from '../shared/prompts.js';
import { DROID_SESSIONS_DIR } from './droid-session.js';
import { imageAddress, imageAt, imageRef, IMAGES_PER_ENTRY, promptPictures } from './thread-images.js';
import { WorkspaceTexts } from './thread-workspace.js';

const PAGE_SIZE = 100;
const FIELD_CHARS = 12_000;
// Leaves room for 60k+ replies and thoughts while even worst-case JSON escaping fits a page.
const ASSISTANT_CHARS = 128 * 1024;
const TOOL_OUTPUT_CHARS = 12_000;
const RESPONSE_BYTES = 900_000;
const LINE_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const TRUNCATED = '\n[… truncated]';
const SESSION_ID = /^[a-zA-Z0-9-]{1,160}$/;
const OUTPUT_ID = /^(\d{1,15})\.(\d{1,4})\.([0-9a-f]{32})$/;

/** An office notice as the Thread shows it. */
function officeNotice(text: string): string {
  return `Office notice: ${text.replace(/^Droid Office notice:\s*/, '')}`;
}

export interface ThreadSession {
  sessionId: string;
  cwd: string;
  /** Ignore text preceding an Office /clear, even if Droid keeps the same session file. */
  since?: number;
  /** The worker's own drops folder: a prompt shows the pictures sent with it only from there. */
  drops?: string;
  /** Its conversation file, as its hooks named it (transcript_path): looked at before searching. */
  transcript?: string;
}

export interface ThreadPage {
  sessionId?: string;
  entries: ThreadEntry[];
  hasMore: boolean;
  presentation?: ThreadPresentation;
  error?: string;
}

interface Projection {
  text: string;
  since: number;
  entries: ThreadEntry[];
  tools: Map<string, ThreadEntry>;
  bytes: number;
  seq: number;
  dropped: boolean;
  before: number;
  drops?: string;
  /** The reason the office last blocked a Stop with, until the user message carrying it (see officeHook). */
  blocked?: string;
  /** Leave a position before the next prompt for a turn outcome the daemon may append late. */
  openPrompt?: string;
  turnEndSlots: Map<string, number>;
}

interface CachedSession {
  file?: string;
  stamp?: string;
  inode?: string;
  size: number;
  position: number;
  pending: Buffer;
  oversized: boolean;
  head: Buffer;
  tail: Buffer;
  projection: Projection;
  refresh?: Promise<void>;
  pages: Map<number, Promise<ThreadPage>>;
  /** The window's rows for one file state and busy flag: polls between changes reuse them. */
  rows?: { key: string; rows: ThreadRow[] };
  /** Cached edited file paths for one transcript `stamp`. */
  editedPaths?: { stamp: string; paths: string[] };
  /** Cached latest page for `before === undefined` when `rows.key` has not changed. */
  latestPage?: { key: string; page: ThreadPage };
  /** When its Task calls were last matched to their subagents' sessions, and how many were. */
  linked?: { at: number; count: number };
}

const object = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Only printable content is projected; transport metadata is never serialized. */
function printable(value: unknown, byOwner = false): string {
  if (typeof value !== 'string') return '';
  return hideOfficeText(value, byOwner)
    .replace(/data:[^\s"'<>]*;base64,[a-zA-Z0-9+/=\s]+/gi, '[attachment omitted]')
    .replace(/[a-zA-Z0-9+/]{256,}={0,2}/g, '[binary data omitted]')
    .trim();
}

function clean(value: unknown, limit = FIELD_CHARS, byOwner = false): string {
  const text = printable(value, byOwner);
  return text.length > limit ? text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '') + TRUNCATED : text;
}

function messageText(value: unknown, role: 'user' | 'assistant'): string {
  return clean(value, role === 'assistant' ? ASSISTANT_CHARS : FIELD_CHARS, role === 'user');
}

function pretty(value: unknown): string {
  return clean(
    JSON.stringify(
      value,
      (key, item: unknown) => {
        if (/^(signature|signatureProvider|encrypted.*|system.?prompt|systemInfo.*|hook.*|userMessageSource|data)$/i.test(key)) return undefined;
        if (typeof item === 'string') return clean(item);
        return item;
      },
      2,
    ),
  );
}

function contentText(content: unknown, limit = FIELD_CHARS): string {
  if (typeof content === 'string') return clean(content, limit);
  if (!Array.isArray(content)) return '';
  return clean(
    content
      .slice(0, 1024)
      .map((part) => {
        const p = object(part);
        return p.type === 'text' ? clean(p.text, limit) : p.type === 'image' ? IMAGE_PLACEHOLDER : '';
      })
      .filter(Boolean)
      .join('\n'),
    limit,
  );
}

function outputPreview(output: string): string {
  if (output.length <= TOOL_OUTPUT_CHARS) return output;
  const cut = output.length - TOOL_OUTPUT_CHARS;
  // Keep complete lines unless the final line alone is oversized. In that case keep its ending.
  const boundary = output[cut - 1] === '\n' ? cut : output.indexOf('\n', cut) + 1;
  const start = boundary || cut;
  let hidden = 0;
  for (let at = output.indexOf('\n'); at >= 0 && at < start; at = output.indexOf('\n', at + 1)) hidden++;
  const lines = hidden ? `${hidden} earlier ${hidden === 1 ? 'line' : 'lines'} hidden` : '';
  const partial = boundary ? '' : lines ? '; start of last line hidden' : 'Start of line hidden';
  return `[${lines}${partial}]\n${output.slice(start).replace(/^[\uDC00-\uDFFF]/, '')}`;
}

function outputHash(toolId: string, output: string): string {
  return createHash('sha256')
    .update(JSON.stringify([toolId, output]))
    .digest('hex')
    .slice(0, 32);
}

function visibleMessage(row: Record<string, unknown>, message: Record<string, unknown>): boolean {
  return (
    (message.role === 'user' || message.role === 'assistant') &&
    ![message, row].some((item) => Object.keys(item).some((key) => key.startsWith('hook'))) &&
    [message.visibility, row.visibility].every((visibility) => visibility === undefined || visibility === 'both' || visibility === 'user_only') &&
    (!message.userMessageSource || message.userMessageSource === 'cli_tui')
  );
}

/**
 * A call made inside a Script records only a stand-in for a picture it returned, without the data: the
 * picture itself arrives in the Script's own result (Droid's `image()`).
 */
function pictureStandIn(content: unknown): boolean {
  if (typeof content !== 'string' || !content.startsWith('{"type":"image"')) return false;
  try {
    const part = object(JSON.parse(content));
    return part.type === 'image' && object(part.source).type === 'base64';
  } catch {
    return false;
  }
}

/** A record's own timestamp, when it has one. */
function stamp(row: Record<string, unknown>): { at?: number } {
  const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  return Number.isFinite(at) ? { at } : {};
}

const leaf = (name = '') => name.split(/[.:/]/).at(-1)?.toLowerCase() ?? '';

const projection = (before = Infinity, since = 0, drops?: string): Projection => ({ text: '', since, entries: [], tools: new Map(), bytes: 0, seq: 0, dropped: false, before, drops, turnEndSlots: new Map() });
const entryBytes = (entry: ThreadEntry) => Buffer.byteLength(JSON.stringify(entry));

/** A bounded recent window, with disk scans only for explicit older-page requests. */
export class WorkerThreadReader {
  private sessions = new Map<string, CachedSession>();
  private files = new WorkspaceTexts();
  /** Each session file's opening record, as far as subagents go: who started it, from which call. */
  private heads = new Map<string, { calling?: string; tool?: string }>();

  constructor(
    private root = DROID_SESSIONS_DIR,
    private limits = { sessions: 16, entries: 1000, bytes: 2 * 1024 * 1024 },
    private textOnly = false,
  ) {}

  /** Synchronous best-effort paths for immediate `fs.watch` binding before async canonical discovery completes. */
  sessionPathsSync(source: ThreadSession): { file?: string; dir: string; root: string } | undefined {
    const { sessionId, cwd, transcript } = source;
    if (!SESSION_ID.test(sessionId) || !path.isAbsolute(cwd)) return undefined;
    const name = `${sessionId}.jsonl`;
    const key = JSON.stringify([cwd, sessionId, source.since ?? 0]);
    const cached = this.sessions.get(key)?.file;
    if (cached && existsSync(cached)) return { file: cached, dir: path.dirname(cached), root: this.root };
    if (transcript && path.basename(transcript) === name) {
      const rel = path.relative(this.root, transcript);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return { ...(existsSync(transcript) ? { file: transcript } : {}), dir: path.dirname(transcript), root: this.root };
      }
    }
    const dir = path.join(this.root, cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
    const guess = path.join(dir, name);
    return { ...(existsSync(guess) ? { file: guess } : {}), dir, root: this.root };
  }

  /** Canonical `.jsonl` file (when created) and expected session directory for `fs.watch` subscriptions. */
  async sessionPaths(source: ThreadSession): Promise<{ file?: string; dir: string; root: string } | undefined> {
    const { sessionId, cwd, transcript } = source;
    if (!SESSION_ID.test(sessionId) || !path.isAbsolute(source.cwd)) return undefined;
    const known = this.sessions.get(JSON.stringify([cwd, sessionId, source.since ?? 0]))?.file;
    const file = known && existsSync(known) ? known : await this.find(source);
    if (file) return { file, dir: path.dirname(file), root: this.root };
    const name = `${sessionId}.jsonl`;
    if (transcript && path.basename(transcript) === name) {
      const rel = path.relative(this.root, transcript);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return { dir: path.dirname(transcript), root: this.root };
      }
    }
    // Droid may name the folder after the cwd as given or as resolved (symlinked tmp or worktree paths), as find() allows.
    const canonical = await realpath(cwd).catch(() => cwd);
    const dirs = [cwd, canonical].map((p) => path.join(this.root, p.replace(/[^a-zA-Z0-9-]/g, '-')));
    return { dir: dirs.find((d) => existsSync(d)) ?? dirs[1], root: this.root };
  }

  /** Independent text window: a long stretch of tools cannot evict the conversation. */
  async readText(source: ThreadSession): Promise<string | undefined> {
    const page = await this.read(source);
    if (page.error) return;
    return this.sessions.get(JSON.stringify([source.cwd, source.sessionId, source.since ?? 0]))?.projection.text;
  }

  /** Reads the projected visible text together with the underlying file stamp so unchanged callers can skip hashing. */
  async readTextWithStamp(source: ThreadSession): Promise<{ text: string; stamp?: string } | undefined> {
    const page = await this.read(source);
    if (page.error) return;
    const cached = this.sessions.get(JSON.stringify([source.cwd, source.sessionId, source.since ?? 0]));
    if (!cached?.projection.text) return undefined;
    return { text: cached.projection.text, stamp: cached.stamp };
  }

  /** `busy` is whether the worker is in a turn: only then can the newest activity still be working. */
  async read(source: ThreadSession, before?: number, busy = false): Promise<ThreadPage> {
    const { sessionId, cwd } = source;
    if (!SESSION_ID.test(sessionId) || !path.isAbsolute(cwd)) return this.unavailable();
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) return this.unavailable('Invalid conversation page.');
    const key = JSON.stringify([cwd, sessionId, source.since ?? 0]);
    let cached = this.sessions.get(key);
    if (!cached) {
      while (this.sessions.size >= this.limits.sessions) {
        const idle = [...this.sessions].find(([, item]) => !item.refresh && !item.pages.size);
        if (!idle) return this.unavailable('Conversation reader is busy. Try again shortly.');
        this.sessions.delete(idle[0]);
      }
      cached = this.empty(source.since, source.drops);
      this.sessions.set(key, cached);
    }
    // Map order is the bounded LRU, including a worker changing session or cwd.
    this.sessions.delete(key);
    this.sessions.set(key, cached);
    const state = cached;
    try {
      if (!state.refresh) state.refresh = this.refresh(state, source).finally(() => (state.refresh = undefined));
      await state.refresh;
      if (!state.file) return this.unavailable('The local conversation file is not available yet.');
      const oldest = state.projection.entries[0]?.seq ?? Infinity;
      if (before === undefined || !state.projection.dropped || before > oldest) {
        if (!this.textOnly) await this.linkChildren(state, sessionId);
        // Edit diffs are numbered from the files as they are now, so the rows change when those do.
        let files: Awaited<ReturnType<WorkspaceTexts['read']>> | undefined;
        if (!this.textOnly) {
          const stampKey = state.stamp ?? '';
          if (state.editedPaths?.stamp !== stampKey) {
            state.editedPaths = { stamp: stampKey, paths: editedFilePaths(state.projection.entries) };
          }
          files = await this.files.read(cwd, state.editedPaths.paths);
        }
        const key = `${state.stamp}:${busy}:${files?.key ?? ''}:${state.linked?.count ?? 0}`;
        if (state.rows?.key !== key) state.rows = { key, rows: presentThread(state.projection.entries, busy, { fileText: files?.text }) };
        if (before === undefined) {
          if (state.latestPage?.key !== key) {
            state.latestPage = { key, page: { sessionId, ...this.page(state.projection, undefined, state.rows.rows) } };
          }
          return state.latestPage.page;
        }
        return { sessionId, ...this.page(state.projection, before, state.rows.rows) };
      }
      let page = state.pages.get(before);
      if (!page) {
        if (state.pages.size >= 4) return this.unavailable('Conversation reader is busy. Try again shortly.');
        page = this.older(state.file, sessionId, before, source.drops, cwd).finally(() => state.pages.delete(before));
        state.pages.set(before, page);
      }
      return await page;
    } catch {
      // A disappearing/replaced file must never keep serving another session's stale cache.
      Object.assign(state, this.empty(source.since, source.drops));
      return this.unavailable('The local conversation could not be read. Try again shortly.');
    }
  }

  /**
   * Gives each Task call the session of the subagent it started. Droid opens a subagent's file, beside
   * its caller's, with `session_start` naming the calling session and tool call; a call still
   * unmatched is looked for again at most once a second.
   */
  private async linkChildren(state: CachedSession, sessionId: string, now = Date.now()): Promise<void> {
    if (!state.file) return;
    const open = state.projection.entries.filter((e) => e.kind === 'tool' && leaf(e.name) === 'task' && !e.child);
    const count = state.projection.entries.length - open.length;
    if (!open.length || (state.linked && now - state.linked.at < 1000 && state.linked.count === count)) return;
    const found = await this.children(path.dirname(state.file), sessionId);
    let linked = 0;
    for (const entry of open) {
      const child = found.get(entry.id.slice('tool:'.length));
      if (!child) continue;
      state.projection.bytes -= entryBytes(entry);
      entry.child = child;
      state.projection.bytes += entryBytes(entry);
      linked++;
    }
    state.linked = { at: now, count: count + linked };
  }

  /** Subagent sessions in `dir` started by `sessionId`, by the id of the Task call that started each. */
  private async children(dir: string, sessionId: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const names = await readdir(dir).catch(() => [] as string[]);
    if (this.heads.size > 4096) this.heads.clear();
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const child = name.slice(0, -'.jsonl'.length);
      if (child === sessionId || !SESSION_ID.test(child)) continue;
      const head = await this.head(path.join(dir, name));
      if (head?.calling === sessionId && head.tool) out.set(head.tool, child);
    }
    return out;
  }

  /** A session file's opening record, read once: undefined until its first line is complete. */
  private async head(file: string): Promise<{ calling?: string; tool?: string } | undefined> {
    const known = this.heads.get(file);
    if (known) return known;
    const handle = await open(file, 'r').catch(() => undefined);
    if (!handle) return undefined;
    try {
      const chunk = await this.bytes(handle, 0, CHUNK_BYTES);
      const newline = chunk.indexOf(10);
      if (newline < 0) return undefined;
      let start: Record<string, unknown>;
      try {
        start = object(JSON.parse(chunk.subarray(0, newline).toString('utf8')));
      } catch {
        start = {};
      }
      const head = start.type === 'session_start' ? { calling: clean(start.callingSessionId, 160) || undefined, tool: clean(start.callingToolUseId, 160) || undefined } : {};
      this.heads.set(file, head);
      return head;
    } finally {
      await handle.close();
    }
  }

  /**
   * The conversation of a subagent `source`'s worker started, to read like its own: only a session whose
   * file sits beside the worker's and names the worker's session as its caller.
   */
  async childSession(source: ThreadSession, child: string): Promise<ThreadSession | undefined> {
    if (!SESSION_ID.test(child) || child === source.sessionId || !SESSION_ID.test(source.sessionId) || !path.isAbsolute(source.cwd)) return undefined;
    const parent = this.sessions.get(JSON.stringify([source.cwd, source.sessionId, source.since ?? 0]))?.file ?? (await this.find(source));
    if (!parent) return undefined;
    const file = path.join(path.dirname(parent), `${child}.jsonl`);
    const head = await this.head(file);
    if (head?.calling !== source.sessionId) return undefined;
    return { sessionId: child, cwd: source.cwd, transcript: file, ...(source.drops ? { drops: source.drops } : {}) };
  }

  /** The menu number, single-line preview and full prompt text for a user text entry's rewind point. */
  async rewindPoint(source: ThreadSession, entryId: string): Promise<{ number: number; preview: string; text: string } | undefined> {
    const selected = /^(.*):(?:text|\d+)$/.exec(entryId);
    if (!selected || entryId.length > 170) return undefined;
    const recordId = selected[1];
    const file = await this.find(source);
    if (!file) return undefined;
    const raw = await readFile(file, 'utf8').catch(() => undefined);
    if (!raw) return undefined;
    let found: { number: number; preview: string; text: string } | undefined;
    for (const line of raw.split('\n')) {
      if (!line.includes(recordId)) continue;
      let row: Record<string, unknown>;
      try {
        row = object(JSON.parse(line));
      } catch {
        continue;
      }
      if (row.type !== 'message' || clean(row.id, 160) !== recordId) continue;
      const message = object(row.message);
      if (message.role !== 'user' || !visibleMessage(row, message) || isThreadSystemMessage(recordId, contentText(message.content))) return undefined;
      const suffix = entryId.slice(recordId.length + 1);
      if (suffix === 'text' ? typeof message.content !== 'string' : object(Array.isArray(message.content) ? message.content[Number(suffix)] : undefined).type !== 'text') return undefined;
      const full = clean(contentText(message.content), FIELD_CHARS, true);
      const sent = await promptPictures(full, source.drops);
      const text = sent ? sent.text : full;
      const preview = clean(full, 1000).replace(/\s+/g, ' ').trim();
      if (!preview) return undefined;
      if (typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq < 0 || found) return undefined;
      found = { number: row.seq + 1, preview, text };
    }
    return found;
  }

  private unavailable(error = 'Conversation is unavailable for this worker.'): ThreadPage {
    return { entries: [], hasMore: false, error };
  }

  private empty(since = 0, drops?: string): CachedSession {
    return {
      size: 0,
      position: 0,
      pending: Buffer.alloc(0),
      oversized: false,
      head: Buffer.alloc(0),
      tail: Buffer.alloc(0),
      projection: projection(Infinity, since, drops),
      pages: new Map(),
      rows: undefined,
      editedPaths: undefined,
      latestPage: undefined,
      linked: undefined,
    };
  }

  private async find({ sessionId, cwd, transcript }: ThreadSession): Promise<string | undefined> {
    const name = `${sessionId}.jsonl`;
    // Prefer a known transcript path when it belongs to this session and is inside the sessions folder.
    if (transcript && path.basename(transcript) === name) {
      const rel = path.relative(this.root, transcript);
      const inside = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      if (
        inside &&
        (await stat(transcript).then(
          (s) => s.isFile(),
          () => false,
        ))
      )
        return transcript;
    }
    const canonical = await realpath(cwd).catch(() => cwd);
    for (const directory of new Set([cwd, canonical])) {
      const guess = path.join(this.root, directory.replace(/[^a-zA-Z0-9-]/g, '-'), name);
      if (
        await stat(guess).then(
          (s) => s.isFile(),
          () => false,
        )
      )
        return guess;
    }
    // Match Droid's discovery fallback, but validate the recorded cwd before using a fallback.
    for (const directory of await readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (!directory.isDirectory()) continue;
      const file = path.join(this.root, directory.name, name);
      const handle = await open(file, 'r').catch(() => undefined);
      if (!handle) continue;
      try {
        const head = await this.bytes(handle, 0, CHUNK_BYTES);
        const newline = head.indexOf(10);
        if (newline < 0) continue;
        const start = object(JSON.parse(head.subarray(0, newline).toString('utf8')));
        if (start.type !== 'session_start') continue;
        // A session moved to another folder (a fork into its worktree) stays filed under its first cwd and records the new one as lastCwd.
        for (const recorded of [start.cwd, start.lastCwd]) {
          if (typeof recorded === 'string' && (recorded === cwd || (await realpath(recorded).catch(() => recorded)) === canonical)) return file;
        }
      } catch {
        // An incomplete header can be retried on the next read.
      } finally {
        await handle.close();
      }
    }
    return undefined;
  }

  private async refresh(state: CachedSession, source: ThreadSession): Promise<void> {
    state.file ??= await this.find(source);
    if (!state.file) return;
    const handle = await open(state.file, 'r');
    try {
      const info = await handle.stat();
      const inode = `${info.dev}:${info.ino}`;
      const stamp = `${inode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (stamp === state.stamp) return;
      let reset = state.inode !== inode || info.size <= state.size;
      if (!reset && state.position) {
        const head = await this.bytes(handle, 0, state.head.length);
        const tail = await this.bytes(handle, state.position - state.tail.length, state.tail.length);
        reset = !head.equals(state.head) || !tail.equals(state.tail);
      }
      if (reset) {
        state.position = 0;
        state.pending = Buffer.alloc(0);
        state.oversized = false;
        state.projection = projection(Infinity, state.projection.since, state.projection.drops);
      }
      await this.consume(handle, state, info.size);
      state.head = await this.bytes(handle, 0, Math.min(256, state.position));
      state.tail = await this.bytes(handle, Math.max(0, state.position - 256), Math.min(256, state.position));
      state.inode = inode;
      state.size = info.size;
      state.stamp = stamp;
    } finally {
      await handle.close();
    }
  }

  private async bytes(handle: FileHandle, position: number, size: number): Promise<Buffer> {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, position);
    return buffer.subarray(0, bytesRead);
  }

  private async consume(handle: FileHandle, state: CachedSession, end: number): Promise<void> {
    while (state.position < end) {
      const chunk = await this.bytes(handle, state.position, Math.min(CHUNK_BYTES, end - state.position));
      if (!chunk.length) break;
      const chunkStart = state.position;
      state.position += chunk.length;
      let start = 0;
      for (let at = chunk.indexOf(10); at >= 0; at = chunk.indexOf(10, start)) {
        const part = chunk.subarray(start, at);
        if (!state.oversized && state.pending.length + part.length <= LINE_BYTES) {
          await this.record(state.projection, Buffer.concat([state.pending, part]).toString('utf8'), chunkStart + start - state.pending.length);
        } else {
          this.add(state.projection, { id: `oversized:${state.projection.seq}`, role: 'system', kind: 'notice', text: 'A conversation record was too large to display.' });
        }
        state.pending = Buffer.alloc(0);
        state.oversized = false;
        start = at + 1;
      }
      if (start < chunk.length && !state.oversized) {
        if (state.pending.length + chunk.length - start > LINE_BYTES) {
          state.pending = Buffer.alloc(0);
          state.oversized = true;
        } else {
          state.pending = Buffer.concat([state.pending, chunk.subarray(start)]);
        }
      }
    }
    // The final unterminated record stays pending, and is never parsed until its newline arrives.
  }

  private trim(state: Projection): void {
    while (state.entries.length > this.limits.entries || state.bytes > this.limits.bytes) {
      const removed = state.entries.shift();
      if (!removed) break;
      state.bytes -= entryBytes(removed);
      if (removed.kind === 'tool') state.tools.delete(removed.id);
      state.dropped = true;
    }
  }

  private add(state: Projection, value: Omit<ThreadEntry, 'seq'>, seq = state.seq++): void {
    const entry = { ...value, seq };
    if (entry.seq >= state.before) return;
    let at = state.entries.length;
    while (at > 0 && state.entries[at - 1].seq > seq) at--;
    state.entries.splice(at, 0, entry);
    state.bytes += entryBytes(entry);
    if (entry.kind === 'tool') state.tools.set(entry.id, entry);
    this.trim(state);
  }

  /** `offset` is where the line starts in the file: a picture's id points back at it. */
  private async record(state: Projection, line: string, offset: number): Promise<void> {
    let row: Record<string, unknown>;
    try {
      row = object(JSON.parse(line));
    } catch {
      return;
    }
    if (this.textOnly && row.type !== 'message') return;
    const id = clean(row.id, 160) || `record:${state.seq}`;
    const { at } = stamp(row);
    const when = at !== undefined ? { at } : {};
    if (row.type === 'agent_turn_outcome') {
      const reason = clean(row.reason, 80);
      const turn = clean(row.turnId, 160);
      const seq = state.turnEndSlots.get(turn);
      state.turnEndSlots.delete(turn);
      if (turn && state.openPrompt === turn) state.openPrompt = undefined;
      this.add(state, { id: `turn:${turn || id}:${reason}`, role: 'system', kind: 'notice', text: reason === 'cancelled' ? 'Turn cancelled' : reason ? `Turn ended · ${reason}` : 'Turn ended', ...when }, seq);
      return;
    }
    if (row.type === 'todo_state') {
      const todos = object(row.todos).todos;
      if (Array.isArray(todos)) {
        const text = clean(
          todos
            .slice(0, 100)
            .map((todo, index) => {
              const item = object(todo);
              const status = item.status === 'completed' ? 'completed' : item.status === 'in_progress' ? 'in progress' : 'pending';
              return `${index + 1}. [${status}] ${clean(item.content)}`;
            })
            .join('\n'),
        );
        if (text) this.add(state, { id: `${id}:todo`, role: 'system', kind: 'todo', text, ...when });
      }
      return;
    }
    if (row.type === 'compaction_state') {
      // A provider switch re-serializes the conversation without the model summarizing it: not a compaction to show.
      if (row.summaryKind !== 'provider_switch_serialization') this.add(state, { id: `compaction:${id}`, role: 'system', kind: 'notice', name: 'compaction', text: 'Compacted', ...when });
      return;
    }
    if (row.type !== 'message') return;
    const message = object(row.message);
    if (message.role !== 'user' && message.role !== 'assistant') return;
    if ([message, row].some((item) => Object.keys(item).some((key) => key.startsWith('hook')))) {
      if (!this.textOnly) this.officeHook(state, id, message);
      return;
    }
    if (!visibleMessage(row, message)) return;
    // Slash skills append a separate CLI acknowledgement, not another owner prompt.
    if (message.role === 'user' && message.visibility === 'user_only' && /^Skill "[^"\r\n]+" activated$/.test(contentText(message.content))) return;
    const system = message.role === 'user' && isThreadSystemMessage(id, contentText(message.content));
    const role = message.role;
    if (system) {
      const text = clean(contentText(message.content));
      if (text === state.blocked) state.blocked = undefined;
      if (!this.textOnly && text) this.add(state, { id: `${id}:notice`, role: 'system', kind: 'notice', text: text.startsWith('Droid Office notice:') ? officeNotice(text) : text, ...when });
      return;
    }
    const timestamp = at ?? NaN;
    if (this.textOnly && (!state.since || (Number.isFinite(timestamp) && timestamp >= state.since))) {
      const parts =
        typeof message.content === 'string'
          ? [message.content]
          : Array.isArray(message.content)
            ? message.content
                .slice(0, 1024)
                .filter((part) => object(part).type === 'text')
                .map((part) => object(part).text)
            : [];
      for (const part of parts) {
        const text = clean(part, Infinity, role === 'user').slice(-LABEL_TEXT_CHARS);
        if (text) state.text = `${state.text}\n\n${role}: ${text}`.slice(-LABEL_TEXT_CHARS);
      }
    }
    if (this.textOnly) return;
    const parts = Array.isArray(message.content) ? message.content.slice(0, 1024).map(object) : undefined;
    if (role === 'user') {
      const content = clean(contentText(message.content), FIELD_CHARS, true);
      if (content && content !== state.blocked) {
        if (state.openPrompt) {
          state.turnEndSlots.set(state.openPrompt, state.seq++);
          if (state.turnEndSlots.size > this.limits.entries) {
            const oldest = state.turnEndSlots.keys().next().value;
            if (oldest !== undefined) state.turnEndSlots.delete(oldest);
          }
        }
        state.openPrompt = id;
      }
    }
    if (typeof message.content === 'string') {
      await this.text(state, `${id}:text`, role, messageText(message.content, role), at);
      return;
    }
    if (!parts) return;
    // Attach native daemon images to their owner prompt, including image-only prompts. Preserve block
    // offsets (for image fetch and rewind), and fall back to separate rows for unrenderable parts.
    const promptImages =
      role === 'user'
        ? parts
            .flatMap((part, index) => {
              const image = imageRef(part, `${offset}.${index}.x`);
              return image ? [{ index, image }] : [];
            })
            .slice(0, IMAGES_PER_ENTRY)
        : [];
    const promptTextIndex = parts.findIndex((part) => part.type === 'text' && !!messageText(part.text, role));
    const imageIndices = new Set(promptImages.map(({ index }) => index));
    const promptImageIndex = promptTextIndex >= 0 ? promptTextIndex : promptImages[0]?.index;
    for (const [index, part] of parts.entries()) {
      const partId = `${id}:${index}`;
      if (index === promptImageIndex && promptImages.length) {
        this.add(state, { id: partId, role, kind: 'text', text: messageText(part.text, role), images: promptImages.map(({ image }) => image), ...when });
        continue;
      }
      if (imageIndices.has(index)) continue;
      if (part.type === 'tool_result') {
        const toolId = clean(part.tool_use_id, 160);
        const tool = state.tools.get(`tool:${toolId}`);
        if (!tool) continue;
        state.bytes -= entryBytes(tool);
        const output = pictureStandIn(part.content) ? IMAGE_PLACEHOLDER : contentText(part.content, Infinity);
        tool.output = outputPreview(output);
        if (output.length > TOOL_OUTPUT_CHARS) tool.outputRef = `${offset}.${index}.${outputHash(toolId, output)}`;
        else delete tool.outputRef;
        tool.error = part.is_error === true;
        const images = Array.isArray(part.content)
          ? part.content
              .slice(0, 1024)
              .map((item, sub) => imageRef(item, `${offset}.${index}.${sub}`))
              .filter((image): image is ThreadImage => !!image)
              .slice(0, IMAGES_PER_ENTRY)
          : [];
        if (images.length) tool.images = images;
        else delete tool.images;
        tool.resultSeq = state.seq;
        if (at !== undefined) tool.doneAt = at;
        state.bytes += entryBytes(tool);
        if (images.length && leaf(tool.name) === 'script') this.givePictures(state, tool, images);
        this.trim(state);
      } else if (part.type === 'tool_use') {
        const toolId = clean(part.id, 160);
        if (!toolId) continue;
        this.add(state, { id: `tool:${toolId}`, role: 'assistant', kind: 'tool', name: clean(part.name, 160), input: pretty(part.input), ...when });
      } else if (part.type === 'image') {
        const image = imageRef(part, `${offset}.${index}.x`);
        this.add(state, { id: partId, role, kind: 'notice', text: IMAGE_PLACEHOLDER, ...(image ? { images: [image] } : {}), ...when });
      } else if (part.type === 'text') {
        await this.text(state, partId, role, messageText(part.text, role), at);
      } else if (part.type === 'thinking') {
        const text = clean(part.thinking, ASSISTANT_CHARS);
        // Adjacent records are not thought boundaries: a single message can contain several blocks.
        const tookMs = thinkingDuration(part.durationMs ?? part.tookMs);
        const took = tookMs === undefined ? {} : { tookMs };
        if (text) this.add(state, { id: partId, role, kind: 'thinking', text, ...when, ...took });
      }
    }
  }

  /**
   * The Thread hides a Script that has calls under it, so its pictures go to the calls inside it that
   * returned a picture: one each when the counts match, otherwise all of them to the last such call.
   */
  private givePictures(state: Projection, script: ThreadEntry, images: ThreadImage[]): void {
    const after = state.entries.slice(state.entries.indexOf(script) + 1);
    const next = after.findIndex((entry) => entry.kind === 'tool' && leaf(entry.name) === 'script');
    const calls = (next < 0 ? after : after.slice(0, next)).filter((entry) => entry.kind === 'tool' && !entry.images && entry.output === IMAGE_PLACEHOLDER);
    if (!calls.length) return;
    const give = (entry: ThreadEntry, pictures: ThreadImage[]) => {
      state.bytes -= entryBytes(entry);
      entry.images = pictures;
      state.bytes += entryBytes(entry);
    };
    if (calls.length === images.length) calls.forEach((entry, i) => give(entry, [images[i]]));
    else give(calls[calls.length - 1], images);
    state.bytes -= entryBytes(script);
    delete script.images;
    state.bytes += entryBytes(script);
  }

  /**
   * The record of a hook run. Only what the office said through it shows: a notice it handed over
   * with a tool's result, and the reason it gave for blocking a Stop, whose user message follows.
   */
  private officeHook(state: Projection, id: string, message: Record<string, unknown>): void {
    const event = message.hookEventName;
    const results = Array.isArray(message.hookResults) ? message.hookResults.slice(0, 16) : [];
    for (const [index, result] of results.entries()) {
      const stdout = object(result).stdout;
      if (typeof stdout !== 'string' || !stdout.trimStart().startsWith('{')) continue;
      let out: Record<string, unknown>;
      try {
        out = object(JSON.parse(stdout));
      } catch {
        continue;
      }
      const context = object(out.hookSpecificOutput).additionalContext;
      if (event === 'PostToolUse' && typeof context === 'string' && context.startsWith(OFFICE_SAYS)) this.add(state, { id: `${id}:office:${index}`, role: 'system', kind: 'notice', text: officeNotice(clean(context)) });
      else if (event === 'Stop' && out.decision === 'block' && typeof out.reason === 'string' && out.reason.startsWith(OFFICE_SAYS)) state.blocked = clean(out.reason);
    }
  }

  /** A message's text. The owner's prompt shows the pictures it was sent with instead of where the office kept them. */
  private async text(state: Projection, id: string, role: 'user' | 'assistant', text: string, at?: number): Promise<void> {
    const when = at !== undefined ? { at } : {};
    // The reason the office blocked a Stop with comes back as a user message: it's the office's, not the owner's.
    if (role === 'user' && state.blocked !== undefined && text === state.blocked) {
      state.blocked = undefined;
      this.add(state, { id, role: 'system', kind: 'notice', text: officeNotice(text), ...when });
      return;
    }
    const sent = role === 'user' ? await promptPictures(text, state.drops) : undefined;
    if (sent) this.add(state, { id, role, kind: 'text', text: sent.text, images: sent.images, ...when });
    else if (text) this.add(state, { id, role, kind: 'text', text, ...when });
  }

  /**
   * A picture from the worker's session by the id its entry carries: the record is read again from
   * its offset in the file, so the thread's window never holds image data.
   */
  async image(source: ThreadSession, id: string): Promise<{ type: ThreadImage['type']; body: Buffer } | undefined> {
    const address = imageAddress(id);
    if (!address) return undefined;
    return imageAt(await this.recordAt(source, address.offset), address);
  }

  /** Full sanitized tool result, read from the session only on demand, never kept in the window. */
  async toolOutput(source: ThreadSession, id: string): Promise<string | undefined> {
    const address = OUTPUT_ID.exec(id);
    if (!address) return undefined;
    const row = object(await this.recordAt(source, Number(address[1])));
    if (row.type !== 'message') return undefined;
    const message = object(row.message);
    if (!visibleMessage(row, message) || !Array.isArray(message.content)) return undefined;
    const index = Number(address[2]);
    if (index >= 1024) return undefined;
    const part = object(message.content[index]);
    if (part.type !== 'tool_result' || pictureStandIn(part.content)) return undefined;
    const output = contentText(part.content, Infinity);
    const toolId = clean(part.tool_use_id, 160);
    return toolId && output.length > TOOL_OUTPUT_CHARS && outputHash(toolId, output) === address[3] ? output : undefined;
  }

  private async recordAt(source: ThreadSession, offset: number): Promise<unknown> {
    if (!SESSION_ID.test(source.sessionId) || !path.isAbsolute(source.cwd)) return undefined;
    const key = JSON.stringify([source.cwd, source.sessionId, source.since ?? 0]);
    const file = this.sessions.get(key)?.file ?? (await this.find(source));
    if (!file) return undefined;
    const handle = await open(file, 'r').catch(() => undefined);
    if (!handle) return undefined;
    try {
      const parts: Buffer[] = [];
      let length = 0;
      for (let at = offset; length <= LINE_BYTES; ) {
        const chunk = await this.bytes(handle, at, Math.min(CHUNK_BYTES, LINE_BYTES + 1 - length));
        if (!chunk.length) return undefined;
        const newline = chunk.indexOf(10);
        parts.push(newline < 0 ? chunk : chunk.subarray(0, newline));
        length += chunk.length;
        if (newline >= 0) {
          try {
            return JSON.parse(Buffer.concat(parts).toString('utf8'));
          } catch {
            return undefined;
          }
        }
        at += chunk.length;
      }
      return undefined;
    } finally {
      await handle.close();
    }
  }

  private page(state: Projection, before = Infinity, rows?: readonly ThreadRow[], fileText?: ThreadFileText): Omit<ThreadPage, 'sessionId'> {
    const candidates = state.entries.filter((entry) => entry.seq < before);
    const entries = candidates.slice(-PAGE_SIZE).map((entry) => ({ ...entry }));
    let bytes = Buffer.byteLength(JSON.stringify(entries));
    while (bytes > RESPONSE_BYTES && entries.length > 1) {
      const removed = entries.shift();
      if (removed) bytes -= entryBytes(removed) + 1;
    }
    // Rows come from the whole window, so a group that began before this page keeps its first entry and counts.
    const presentation: ThreadPresentation = { version: THREAD_MODEL_VERSION, rows: pageRows(rows ?? presentThread(state.entries, false, { fileText }), entries, before) };
    return { entries, hasMore: candidates.length > entries.length || (state.dropped && before > 0), presentation };
  }

  private async older(file: string, sessionId: string, before: number, drops: string | undefined, cwd: string): Promise<ThreadPage> {
    const state = this.empty();
    state.projection = projection(before, 0, drops);
    const handle = await open(file, 'r');
    try {
      await this.consume(handle, state, (await handle.stat()).size);
      const files = this.textOnly ? undefined : await this.files.read(cwd, editedFilePaths(state.projection.entries));
      return { sessionId, ...this.page(state.projection, before, undefined, files?.text) };
    } finally {
      await handle.close();
    }
  }
}
