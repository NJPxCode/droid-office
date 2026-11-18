import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { TerminalPathLinksAddon } from './terminal-path-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { Net } from '../net';
import { store } from '../state';
import { withToken } from '../token';
import { TERM_THEME } from '../term-theme';
import { focusReports, suppressMirrorQueries, TerminalMirror } from '../term-mirror';
import { h, hintToast, openModal, STATUS_LABEL, toast, type Modal } from './dom';
import { colorDot } from './kit';
import { ORCHESTRATOR_ID } from '../../shared/mission-control';
import { OFFICE_SHELL_ID } from '../../shared/office-shell';
import type { ServerMsg, WorkerInfo } from '../../shared/protocol';
import { teamSummary, workerTeams } from '../../shared/team';
import { buildingAgent, missionLead, orchestratorMessage } from '../mission';
import { missionTeamLine } from '../mission-office';
import { forkRefusal } from '../../shared/worker-fork';
import { openForkWorker } from './fork-worker';
import { creditsNote } from '../../shared/factory-sessions';
import { findLine } from '../../shared/search';
import { DROP_MAX_BYTES, droppedPaths } from '../../shared/drops';
import { loadFonts, TERM_FONT } from '../fonts';
import { attachKittyTerminal, type ExpandedKittyImage } from '../term-kitty';
import { attachPixelScroll } from '../term-pixel-scroll';
import { wantsCsiEnter } from '../term-keys';
import { viewPicture } from './picture-viewer';
import { createQuestionSlot } from './question-slot';
import { onTermFontSize, setTermFontSize, stepTermFont, termFontSize, TERM_FONT_MAX, TERM_FONT_MIN } from './term-font';
import { followTerminalPrefs, scrollAtOnce, terminalOptions } from './terminal-prefs';
import { mountWorkerThread } from './worker-thread';

function openKittyPicture(img: ExpandedKittyImage, about: string, isAlive: () => boolean, focusTerm: () => void, state: { modal: Modal | null }) {
  if (state.modal || !isAlive()) return;
  const url = URL.createObjectURL(img.blob);
  state.modal = viewPicture(url, 'Terminal image', {
    width: img.width,
    height: img.height,
    about,
    onClose: () => {
      state.modal = null;
      URL.revokeObjectURL(url);
      if (isAlive()) focusTerm();
    },
  });
}

/** A line to scroll to once the terminal has loaded: a search hit (see search.ts). */
export interface TerminalFind {
  /** What was searched for, as a searchKey. */
  needle: string;
  /** How many rows from the bottom of the worker's terminal the line was. */
  fromEnd: number;
}

/** Sends a file dropped or pasted into a worker's terminal to the office; where the office keeps it. */
async function uploadDrop(workerId: string, f: File): Promise<string> {
  const name = f.name || 'That file';
  if (f.size > DROP_MAX_BYTES) throw new Error(`${name} is too big to drop into a terminal (${DROP_MAX_BYTES / 1024 / 1024} MB at most)`);
  const q = new URLSearchParams({ floor: store.floor ?? '', worker: workerId, name: f.name });
  const res = await fetch(withToken(`/api/term/drop?${q}`), { method: 'POST', headers: { 'content-type': f.type || 'application/octet-stream' }, body: f });
  const r = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res.ok || !r.path) throw new Error(r.error ?? `${name} could not be dropped into the terminal`);
  return r.path;
}

let current: { workerId: string; modal: Modal; find(f: TerminalFind): void; streams(): boolean } | null = null;
const threadDrafts = new Map<string, string>();
const questionDrafts = new Map<string, string>();

/**
 * The team strip's people for `w`: its lead and teammates on this floor, or its own subagents. A building
 * agent (the Orchestrator) leads from Mission Control, so its team spans floors and the strip shows the ones
 * here with the whole team's line.
 */
function teamAround(w: WorkerInfo): { lead?: WorkerInfo; mates: WorkerInfo[]; summary?: string } {
  const agent = buildingAgent(store.missionControl, w.id);
  if (agent) return { mates: agent.team.flatMap((m) => store.workers.get(m.id) ?? []), summary: missionTeamLine(agent.team) };
  const building = missionLead(store.missionControl, w.lead);
  if (building) return { lead: building.worker, mates: [...store.workers.values()].filter((x) => x.lead === w.lead && x.id !== w.id) };
  const group = workerTeams(store.workers.values()).find((t) => t.lead.id === w.id || t.children.some((s) => s.id === w.id));
  const mates = group?.children.filter((s) => s.id !== w.id) ?? [];
  return { lead: group && group.lead.id !== w.id ? group.lead : undefined, mates, summary: teamSummary(mates) };
}
/** Opens a teammate's terminal from the team strip (main wires it up, to resume or fix it first). */
let openTeammate: (workerId: string) => void = () => {};

export function onOpenTeammate(fn: (workerId: string) => void) {
  openTeammate = fn;
}
/** Whether we've said, this page load, that Esc now goes to the terminal and how to leave instead. */
let escHinted = false;
const listeners = new Set<(msg: ServerMsg) => void>();

/** Main feeds every server message through here so open terminals can pick theirs. */
export function routeTerminalMessage(msg: ServerMsg) {
  listeners.forEach((fn) => fn(msg));
}

/** The worker whose terminal window is open, if any. */
export function openTerminalFor(): string | null {
  return current?.workerId ?? null;
}

/** Whether the open desk window streams a PTY (`shell` desk or boss shell) rather than a Droid Thread. */
export function openTerminalStreams(): boolean {
  return current?.streams() ?? false;
}

/** The terminal is the front window, not covered by another dialog. */
export function terminalOnTop(): boolean {
  const backdrop = current?.modal.backdrop;
  return !!backdrop && backdrop.parentElement?.lastElementChild === backdrop;
}

/** Closes the open terminal window, if there is one. Inline terminals have their own handles. */
export function closeTerminal() {
  current?.modal.close();
}

/** Where a headerless inline terminal goes, and what Ctrl+] does there. */
export interface InlineTerminal {
  mount: HTMLElement;
  /** Ctrl+] in the terminal: leave it. Without one, Ctrl+] goes to the program. */
  onLeave?: () => void;
  /** Take the keyboard once it has loaded. Defaults to true; a pane opened beside others leaves focus where it is. */
  focus?: boolean;
  /** The containing pane already provides navigation between team members. */
  hideTeam?: boolean;
}

/**
 * An inline terminal. Any number can be open at once, one per worker, and none of them is the
 * terminal window that `openTerminalFor` and `closeTerminal` speak of.
 */
export interface InlineTerminalHandle {
  workerId: string;
  close(): void;
  focus(): void;
  /** Asks the office for a fresh snapshot, after a reconnect. */
  attach(): void;
}

function makeTeamStrip(hide?: boolean) {
  const team = h('div.term-team.chips.hidden', { role: 'group', 'aria-label': 'Team' });
  let teamKey = '';
  return {
    element: team,
    paint(w: WorkerInfo) {
      if (hide) return;
      const { lead, mates, summary } = teamAround(w);
      const chipKey = (x: WorkerInfo | undefined) => (x ? `${x.id}:${x.name}:${x.status}:${x.acked}:${x.title ?? ''}` : '');
      const key = [summary ?? '', chipKey(lead), ...mates.map(chipKey)].join('|');
      if (key === teamKey) return;
      teamKey = key;
      const chip = (x: WorkerInfo) =>
        h(
          'button.chip.team-chip',
          { type: 'button', title: `Open ${x.name}'s ${x.kind === 'shell' ? 'terminal' : 'thread'}${x.title ? `: ${x.title}` : ''}`, onclick: () => openTeammate(x.id) },
          colorDot(x.color),
          h('span.team-chip-name', {}, x.name),
          h('span.pill', { class: x.status }, STATUS_LABEL[x.status] ?? x.status),
        );
      team.classList.toggle('hidden', !lead && !mates.length);
      if (lead) team.replaceChildren(h('span.term-team-label', {}, 'Subagent of'), chip(lead), ...(mates.length ? [h('span.term-team-label', {}, 'with'), ...mates.map(chip)] : []));
      else team.replaceChildren(h('span.term-team-label', {}, summary ?? ''), ...mates.map(chip));
    },
  };
}

function openAgentThreadModal(net: Net, workerId: string, info: WorkerInfo, onChanges?: () => void, find?: TerminalFind) {
  const title = h('h2');
  const sub = h('p.sub.hidden');
  const pill = h('span.pill');
  const changes = onChanges
    ? h(
        'button.btn',
        {
          type: 'button',
          title: 'What this worker changed: files, diff, commit, open a PR (C at the desk)',
          onclick: () => {
            onChanges();
            modal.close();
          },
        },
        '🌿 Changes',
      )
    : null;
  // A building agent has no desk for a fork to sit at.
  const fork = info.kind === 'agent' && info.deskId ? h('button.btn', { type: 'button', onclick: () => openForkWorker(net, workerId) }, 'Fork') : null;
  const close = h('button.btn.icon.close', { title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => modal.close() }, '✕');
  const headerEl = h('header', {}, colorDot(info.color), h('div.titles', {}, h('div.term-title', {}, title, pill), sub), h('div.actions', {}, changes, fork), close);
  const team = makeTeamStrip();
  const threadHost = h('div.term-thread-host');
  const el = h('div.modal.full.term', { role: 'dialog', 'aria-label': `${info.name} thread` }, headerEl, team.element, threadHost);
  const isOrchestrator = workerId === ORCHESTRATOR_ID;

  const questionSlot = createQuestionSlot({
    worker: () => store.worker(workerId),
    entries: () => thread.entries(),
    live: () => net.up,
    readDraft: (id) => questionDrafts.get(id) ?? '',
    saveDraft: (id, text) => (text ? questionDrafts.set(id, text) : questionDrafts.delete(id)),
    send: async (msg) => {
      const result = await net.request(msg);
      return result.ok ? undefined : (result.error ?? 'The office refused that.');
    },
  });

  const thread = mountWorkerThread(net, {
    worker: info,
    question: questionSlot.element,
    draft: threadDrafts.get(workerId) ?? '',
    onDraft: (text) => (text ? threadDrafts.set(workerId, text) : threadDrafts.delete(workerId)),
    onEntries: () => questionSlot.paint(),
    send: async (msg) => {
      const result = await net.request(isOrchestrator ? orchestratorMessage(msg) : msg);
      return result.ok ? undefined : (result.error ?? 'The office refused that.');
    },
    openChanges: onChanges
      ? () => {
          onChanges();
          modal.close();
        }
      : undefined,
    openWorker: (id) => openTeammate(id),
    team: () => [...store.workers.values()],
    floor: isOrchestrator ? undefined : (store.floor ?? undefined),
    ...(isOrchestrator ? { promptWakes: true } : {}),
  });
  threadHost.append(thread.element);

  const refreshHeader = (w: WorkerInfo) => {
    title.textContent = ['Droid', w.name].filter(Boolean).join(' · ');
    title.title = title.textContent;
    sub.textContent = [
      w.task?.name ?? w.title,
      w.forkedFrom && `Fork of ${w.forkedFrom.name}`,
      w.worktree && `🌿 ${w.worktree.branch}`,
      creditsNote(store.factory.sessions, w.sessionId),
      w.repos?.length && `🗂️ ${[w.worktree?.path.split(/[\\/]/).pop(), ...w.repos.map((r) => r.name)].join(' + ')}`,
    ]
      .filter(Boolean)
      .join(' · ');
    sub.title = sub.textContent;
    sub.classList.toggle('hidden', !sub.textContent);
    pill.className = `pill ${w.status}`;
    pill.textContent = STATUS_LABEL[w.status] ?? w.status;
    if (fork) {
      const why = forkRefusal(w);
      fork.disabled = !net.up || !!why;
      fork.title = why ?? 'Fork this conversation and its files into an independent worker';
    }
  };

  const refresh = () => {
    const w = store.worker(workerId);
    if (!w) {
      modal.close();
      return;
    }
    refreshHeader(w);
    team.paint(w);
    thread.update(w, net.up);
    questionSlot.paint();
  };

  const offWorkers = store.on('workers', refresh);
  const offMission = store.on('missionControl', refresh);
  const unsubCredits = store.on('factory', refresh);
  const offStatus = net.onStatus((up) => {
    const w = store.worker(workerId) ?? info;
    refreshHeader(w);
    thread.update(w, up);
    questionSlot.paint();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.key === ']') {
      e.preventDefault();
      modal.close();
    }
  };
  el.addEventListener('keydown', onKey);

  const modal = openModal(el, {
    backdropCloses: true,
    doing: `💬 in ${info.name}'s thread`,
    onClose: () => {
      el.removeEventListener('keydown', onKey);
      offWorkers();
      offMission();
      unsubCredits();
      offStatus();
      questionSlot.dispose();
      thread.dispose();
      if (current?.modal === modal) current = null;
    },
  });
  thread.dropZone(modal.backdrop, el);
  current = {
    workerId,
    modal,
    streams: () => false,
    find: (f) => thread.search(f.needle),
  };
  refresh();
  thread.activate(true);
  if (find) thread.search(find.needle);
  else setTimeout(() => thread.element.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)')?.focus(), 30);
}

/**
 * Opens a Droid session's Thread modal (`agent` or `ORCHESTRATOR_ID`) or a `shell` worker's terminal.
 * With `inline`, mounts a headerless inline `xterm.js` terminal inside `inline.mount`.
 */
export function openTerminal(net: Net, workerId: string, onChanges?: () => void, find?: TerminalFind): void;
export function openTerminal(net: Net, workerId: string, onChanges: (() => void) | undefined, find: TerminalFind | undefined, inline: InlineTerminal): InlineTerminalHandle | undefined;
export function openTerminal(net: Net, workerId: string, onChanges?: () => void, find?: TerminalFind, inline?: InlineTerminal): InlineTerminalHandle | undefined {
  if (!inline) {
    if (current?.workerId === workerId) {
      if (find) current.find(find);
      return;
    }
    current?.modal.close();
  }
  const info = store.worker(workerId);
  // An external bot runs elsewhere and has no terminal here: its card in Mission Control stands in.
  if (!info || info.remote) return;
  if (!inline && (info.kind === 'agent' || workerId === ORCHESTRATOR_ID) && !info.cloud) {
    openAgentThreadModal(net, workerId, info, onChanges, find);
    return;
  }

  const header = inline
    ? undefined
    : (() => {
        const title = h('h2');
        const sub = h('p.sub.hidden');
        const pill = h('span.pill');
        const smaller = h('button.btn.icon', { type: 'button', title: 'Smaller text', 'aria-label': 'Smaller terminal text', onclick: () => zoomBy(-1) }, 'A−');
        const bigger = h('button.btn.icon', { type: 'button', title: 'Bigger text', 'aria-label': 'Bigger terminal text', onclick: () => zoomBy(1) }, 'A+');
        const zoom = h('span.seg.term-zoom', { role: 'group', 'aria-label': 'Terminal text size' }, smaller, bigger);
        const changes = onChanges
          ? h(
              'button.btn',
              {
                type: 'button',
                title: 'What this worker changed: files, diff, commit, open a PR (C at the desk)',
                onclick: () => {
                  onChanges();
                  modal.close();
                },
              },
              '🌿 Changes',
            )
          : null;
        const close = h('button.btn.icon.close', { title: 'Leave terminal (Shift+Esc or Ctrl+]) · Esc goes to the terminal', 'aria-label': 'Close', onclick: () => modal.close() }, '✕');
        const element = h('header', {}, colorDot(info.color), h('div.titles', {}, h('div.term-title', {}, title, pill), sub), h('div.actions', {}, zoom, changes), close);
        const zoomBy = (dir: 1 | -1) => {
          setTermFontSize(stepTermFont(term.options.fontSize ?? termFontSize(), dir));
          term.focus();
        };
        return {
          element,
          refresh(w: WorkerInfo) {
            title.textContent = w.name;
            title.title = title.textContent;
            sub.textContent = [w.task?.name ?? w.title, w.worktree && `🌿 ${w.worktree.branch}`, w.repos?.length && `🗂️ ${[w.worktree?.path.split(/[\\/]/).pop(), ...w.repos.map((r) => r.name)].join(' + ')}`].filter(Boolean).join(' · ');
            sub.title = sub.textContent;
            sub.classList.toggle('hidden', !sub.textContent);
            pill.className = `pill ${w.status}`;
            pill.textContent = STATUS_LABEL[w.status] ?? w.status;
          },
          zoom(px: number) {
            smaller.toggleAttribute('disabled', px <= TERM_FONT_MIN);
            bigger.toggleAttribute('disabled', px >= TERM_FONT_MAX);
            zoom.title = `Text size ${px} px`;
          },
        };
      })();
  const disconnected = h('p.note.warn.hidden', { role: 'status' }, 'Disconnected. Terminal input is disabled until a fresh snapshot arrives.');
  const host = h('div.term-host', { 'data-drop': 'Drop screenshots or files to put them in the terminal' });
  const team = makeTeamStrip(inline?.hideTeam);
  const el = h(
    inline ? 'div.modal.term.inline' : 'div.modal.full.term',
    inline ? { role: 'region', 'aria-label': `${info.name} terminal` } : { role: 'dialog', 'aria-label': `${info.name} terminal` },
    header?.element ?? null,
    team.element,
    disconnected,
    host,
  );

  const pathLinks = new TerminalPathLinksAddon({ floor: () => store.floor ?? '', workerId, workerName: info.name });
  const term = new Terminal({
    ...terminalOptions(),
    fontFamily: TERM_FONT,
    fontSize: termFontSize(),
    theme: TERM_THEME,
    minimumContrastRatio: 4.5,
    disableStdin: true,
    scrollback: 5000,
    allowProposedApi: true,
    linkHandler: pathLinks.linkHandler,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(pathLinks);
  // The addon's default opens a blank window and then assigns its location. Electron's window
  // open handler only sees the blank URL and denies it, so pass the real URL up front.
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      window.open(uri, '_blank', 'noopener,noreferrer');
    }),
  );
  // Unicode 11 widths, so powerline glyphs, emoji, CJK and combining marks take the cells
  // they should instead of overlapping or leaving gaps (oh-my-zsh, agnoster…).
  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  term.unicode.activeVersion = '11';
  let opened = false;
  let alive = true;
  const expanded = { modal: null as Modal | null };
  const kitty = attachKittyTerminal(term, {
    onExpandImage: (img) =>
      openKittyPicture(
        img,
        store.worker(workerId)?.name ?? info.name,
        () => alive,
        () => term.focus(),
        expanded,
      ),
  });
  const pixel = attachPixelScroll(term);

  const offQueries = suppressMirrorQueries(term);
  const focus = focusReports();
  let lastSentSize = '';
  let lastPtySize = '';
  const pendingSizes: string[] = [];
  let paneSizeChanged = false;
  /**
   * Whether another window already had this terminal open when this one attached. Merely
   * opening or resizing then adopts the shared size instead of reflowing the terminal under
   * it; typing or changing an inline pane's box reclaims the size. Captured when attaching: the
   * open flag includes this window afterwards, so it can't tell them apart any more.
   */
  let adoptSharedSize = false;
  /** Sizes the shared PTY to this window, or this window to the shared PTY (see adoptSharedSize). */
  const sendSize = (typing = false) => {
    if (!mirror.ready || !opened || !net.up) return;
    if (!host.clientWidth || !host.clientHeight) return;
    if (typing || paneSizeChanged) adoptSharedSize = false;
    paneSizeChanged = false;
    if (!typing && adoptSharedSize) {
      const w = store.worker(workerId);
      if (w && (w.cols !== term.cols || w.rows !== term.rows)) term.resize(w.cols, w.rows);
      return;
    }
    try {
      const size = fit.proposeDimensions();
      if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return;
      // Match WorkerManager.resize's limits so the server can acknowledge the exact request.
      term.resize(Math.max(20, Math.min(400, size.cols)), Math.max(5, Math.min(200, size.rows)));
    } catch {
      return;
    }
    const key = `${term.cols}x${term.rows}`;
    const w = store.worker(workerId);
    if (w && (pendingSizes.length || w.cols !== term.cols || w.rows !== term.rows) && key !== lastSentSize) {
      lastSentSize = key;
      pendingSizes.push(key);
      net.send({ t: 'term.resize', workerId, cols: term.cols, rows: term.rows });
    }
  };

  const refresh = () => {
    const w = store.worker(workerId);
    if (!w) {
      modal.close();
      return;
    }
    header?.refresh(w);
    team.paint(w);
    // Status updates can still carry the old size while our resize is in flight. Only a new
    // PTY size not acknowledging one of our requests means another window claimed it.
    const ptySize = `${w.cols}x${w.rows}`;
    const changed = ptySize !== lastPtySize;
    lastPtySize = ptySize;
    const acknowledged = changed ? pendingSizes.indexOf(ptySize) : -1;
    if (acknowledged >= 0) pendingSizes.splice(0, acknowledged + 1);
    if (mirror.ready && changed && acknowledged < 0 && ptySize !== `${term.cols}x${term.rows}` && ptySize !== lastSentSize) {
      adoptSharedSize = true;
      term.resize(w.cols, w.rows);
      lastSentSize = '';
      pendingSizes.length = 0;
    }
  };

  /** Scrolls a search hit into view and lights it up for a few seconds. */
  const jumpTo = (f: TerminalFind) => {
    const buf = term.buffer.active;
    const row = findLine(buf, f.needle, f.fromEnd);
    if (row === undefined) return toast('That line has scrolled out of the terminal since', 'warn');
    let end = row;
    while (buf.getLine(end + 1)?.isWrapped) end++;
    // A marker follows the line when the terminal reflows, which it does as the window settles.
    const marker = term.registerMarker(row - (buf.baseY + buf.cursorY));
    if (!marker) return;
    const mark = term.registerDecoration({ marker, width: term.cols, height: end - row + 1, backgroundColor: TERM_THEME.yellow, foregroundColor: TERM_THEME.background });
    const scroll = () => {
      if (marker.line < 0) return;
      // xterm scrolls from where its scrollbar is, which lags behind a resize; from the top is exact.
      scrollAtOnce(term, () => {
        term.scrollLines(-term.buffer.active.length);
        term.scrollLines(Math.max(0, marker.line - Math.floor(term.rows / 3)));
      });
    };
    scroll();
    // The window settles its size just after it opens; stay on the line through that.
    const follow = term.onResize(() => setTimeout(scroll, 50));
    setTimeout(() => follow.dispose(), 1500);
    setTimeout(() => {
      mark?.dispose();
      marker.dispose();
    }, 8000);
  };
  let pendingFind = find;

  const mirror = new TerminalMirror(
    term,
    (snapshot) => {
      adoptSharedSize = snapshot.shared ?? adoptSharedSize;
      const focusIn = focus.reset(document.hasFocus() && document.activeElement === term.textarea, term.modes.sendFocusMode);
      if (focusIn) net.send({ t: 'term.input', workerId, data: focusIn });
      lastSentSize = '';
      pendingSizes.length = 0;
      term.options.disableStdin = !net.up;
      disconnected.classList.add('hidden');
      sendSize();
      scrollAtOnce(term, () => term.scrollToBottom());
      refresh();
      if (pendingFind) jumpTo(pendingFind);
      pendingFind = undefined;
    },
    () => net.send({ t: 'worker.attach', workerId }),
  );
  // Keep a scrolled-up reader's exact history. Only a following companion terminal can discard
  // invisible output and return to the latest snapshot, without retaining an unbounded backlog.
  const visibility = () => {
    if (!inline) return;
    if (!document.hidden || term.buffer.active.viewportY >= term.buffer.active.baseY) {
      const changed = mirror.setVisible(!document.hidden);
      if (document.hidden && changed) net.send({ t: 'worker.detach', workerId });
      else if (!document.hidden && !changed && !mirror.ready) net.send({ t: 'worker.attach', workerId });
      term.options.disableStdin = !net.up || !mirror.ready;
    }
  };
  if (inline) document.addEventListener('visibilitychange', visibility);
  if (document.hidden) visibility();
  const onMsg = (msg: ServerMsg) => {
    if (msg.t === 'term.data' && msg.workerId === workerId) mirror.data(msg.data);
    else if (msg.t === 'term.snapshot' && msg.workerId === workerId) {
      term.options.disableStdin = true;
      mirror.snapshot(msg);
    }
  };
  listeners.add(onMsg);
  // A building agent (the Orchestrator) comes and goes with Mission Control state, not the floor's workers.
  const offWorkers = store.on('workers', refresh);
  const offMission = store.on('missionControl', refresh);
  const unsub = () => {
    offWorkers();
    offMission();
  };
  const unsubCredits = store.on('factory', refresh);
  let box: { width: number; height: number } | undefined;
  const ro = new ResizeObserver(([entry]) => {
    if (!entry) return;
    const { width, height } = entry.contentRect;
    if (width <= 0 || height <= 0) return;
    // The initial observation is not a layout change and must not seize a shared terminal.
    // Keep a change pending through snapshot loading/disconnection, without fitting hidden boxes.
    if (box && (width !== box.width || height !== box.height)) paneSizeChanged = true;
    box = { width, height };
    sendSize();
  });
  const offStatus = net.onStatus((up) => {
    header?.refresh(store.worker(workerId) ?? info);
    if (up) return; // The welcome handler reattaches only after the authoritative worker snapshot.
    mirror.disconnect();
    term.options.disableStdin = true;
    disconnected.classList.remove('hidden');
  });

  const onClose = () => {
    document.removeEventListener('visibilitychange', visibility);
    listeners.delete(onMsg);
    unsub();
    unsubCredits();
    offStatus();
    offQueries();
    mirror.disconnect();
    offFont();
    offPrefs();
    ro.disconnect();
    net.send({ t: 'worker.detach', workerId });
    term.dispose();
    alive = false;
    if (current?.modal === modal) current = null;
  };
  let modal: Modal;
  if (inline) {
    let closed = false;
    modal = {
      el,
      backdrop: inline.mount,
      close() {
        if (closed) return;
        closed = true;
        el.remove();
        onClose();
      },
    };
    inline.mount.replaceChildren(el);
  } else
    modal = openModal(el, {
      backdropCloses: true,
      // TUIs use Esc to back out of their own menus, so while you're typing in the terminal it goes
      // to the program. Shift+Esc (or Ctrl+], or Esc once focus is off the terminal) leaves.
      escCloses: (e) => {
        if (e.shiftKey || !host.contains(document.activeElement)) return true;
        if (!escHinted) {
          escHinted = true;
          hintToast('Esc went to the terminal. Shift+Esc or Ctrl+] leaves it');
        }
        return false;
      },
      doing: `💻 in ${info.name}'s terminal`,
      onClose,
    });
  const csiEnter = () => wantsCsiEnter(store.worker(workerId)?.kind);
  if (!inline)
    current = {
      workerId,
      modal,
      streams: () => true,
      find: (f) => {
        if (mirror.ready) jumpTo(f);
        else pendingFind = f;
      },
    };
  header?.zoom(termFontSize());
  const offFont = onTermFontSize((px) => {
    term.options.fontSize = px;
    header?.zoom(px);
    paneSizeChanged = true;
    sendSize();
  });
  const offPrefs = followTerminalPrefs(term, {
    resized: () => {
      paneSizeChanged = true;
      sendSize();
    },
  });

  term.attachCustomKeyEventHandler((e) => {
    if (e.ctrlKey && e.key === ']' && (!inline || inline.onLeave)) {
      if (e.type === 'keydown') {
        if (inline) inline.onLeave?.();
        else modal.close();
      }
      return false;
    }
    if (!inline && e.key === 'Escape' && e.shiftKey) return false;
    const action = kitty.keyAction(e, csiEnter());
    if (action.do === 'default') return !pixel.handleKey(e);
    if (action.do === 'send') {
      e.preventDefault();
      term.input(action.data);
    }
    return false;
  });
  term.onData((data) => {
    if (!mirror.ready || !net.up) return;
    const kind = focus.classify(data);
    if (kind === 'repeat') return;
    // Focus moving is not typing, so it leaves the shared PTY at its size.
    if (kind === 'input') sendSize(true);
    net.send({ t: 'term.input', workerId, data });
  });

  // Files dropped in, or a screenshot pasted, go up to the office's machine and the terminal types
  // where they are, as a terminal does with a file dragged into it: Droid attaches a picture.
  let uploading = 0;
  const insertFiles = async (files: File[]) => {
    if (!files.length) return;
    if (!mirror.ready || !net.up) return toast('Disconnected. No files were sent.', 'warn');
    el.classList.toggle('uploading', ++uploading > 0);
    try {
      const paths = await Promise.all(files.map((f) => uploadDrop(workerId, f)));
      if (!alive || !mirror.ready || !net.up) return;
      sendSize(true);
      term.paste(droppedPaths(paths));
      term.focus();
    } catch (err) {
      toast((err as Error).message, 'warn');
    } finally {
      el.classList.toggle('uploading', --uploading > 0);
    }
  };
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  // The whole screen is the drop zone while the terminal is open, so a near miss doesn't open the file in the browser.
  let dragDepth = 0;
  const dragEnd = () => {
    dragDepth = 0;
    el.classList.remove('dropping');
  };
  modal.backdrop.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    el.classList.add('dropping');
  });
  modal.backdrop.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  modal.backdrop.addEventListener('dragleave', (e) => {
    if (hasFiles(e) && --dragDepth <= 0) dragEnd();
  });
  modal.backdrop.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragEnd();
    void insertFiles([...e.dataTransfer!.files]);
  });
  // A picture on the clipboard with no text (a screenshot) pastes like a dropped file. Caught on the
  // way down, before xterm would paste it as nothing.
  host.addEventListener(
    'paste',
    (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length || e.clipboardData?.getData('text/plain')) return;
      e.preventDefault();
      e.stopPropagation();
      void insertFiles(files);
    },
    true,
  );

  refresh();
  // xterm caches glyph widths when it opens. Opening after the shared font load prevents a
  // slow first visit from retaining fallback measurements even after the icons arrive.
  void loadFonts().then(() => {
    if (!alive) return;
    term.open(host);
    opened = true;
    ro.observe(host);
    adoptSharedSize = store.worker(workerId)?.open === true;
    if (!inline || !document.hidden) net.send({ t: 'worker.attach', workerId });
    setTimeout(() => {
      if (alive && inline?.focus !== false) term.focus();
    }, 50);
  });
  if (!inline) return;
  return {
    workerId,
    close: () => modal.close(),
    focus: () => term.focus(),
    attach: () => {
      if (alive && opened && !document.hidden) net.send({ t: 'worker.attach', workerId });
    },
  };
}

/**
 * The boss monitor's shell. The same kind of terminal as a shell worker's, but there is no worker:
 * no status, no changes, no team. `OFFICE_SHELL_ID` is what `openTerminalFor` reports while it's open,
 * so a reconnect can attach again.
 */
export function openOfficeShell(net: Net) {
  if (current?.workerId === OFFICE_SHELL_ID) return;
  current?.modal.close();
  const where = store.project?.name || 'this floor';
  const title = h('h2', {}, 'Shell');
  const sub = h('p.sub', {}, where);
  const pill = h('span.pill', {}, 'shell');
  const smaller = h('button.btn.icon', { type: 'button', title: 'Smaller text', 'aria-label': 'Smaller terminal text' }, 'A−');
  const bigger = h('button.btn.icon', { type: 'button', title: 'Bigger text', 'aria-label': 'Bigger terminal text' }, 'A+');
  const zoom = h('span.seg.term-zoom', { role: 'group', 'aria-label': 'Terminal text size' }, smaller, bigger);
  const closeBtn = h('button.btn.icon.close', { title: 'Leave terminal (Shift+Esc or Ctrl+]) · Esc goes to the terminal', 'aria-label': 'Close' }, '✕');
  const host = h('div.term-host', { 'data-drop': 'Drop screenshots or files to put them in the shell' });
  const el = h('div.modal.full.term', { role: 'dialog', 'aria-label': 'Shell' }, h('header', {}, colorDot('#8d99ae'), h('div.titles', {}, h('div.term-title', {}, title, pill), sub), h('div.actions', {}, zoom), closeBtn), host);

  const pathLinks = new TerminalPathLinksAddon({ floor: () => store.floor ?? '', workerId: OFFICE_SHELL_ID });
  const term = new Terminal({
    ...terminalOptions(),
    fontFamily: TERM_FONT,
    fontSize: termFontSize(),
    theme: TERM_THEME,
    minimumContrastRatio: 4.5,
    scrollback: 5000,
    allowProposedApi: true,
    linkHandler: pathLinks.linkHandler,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(pathLinks);
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      window.open(uri, '_blank', 'noopener,noreferrer');
    }),
  );
  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  term.unicode.activeVersion = '11';
  let shellAlive = true;
  const expanded = { modal: null as Modal | null };
  const kitty = attachKittyTerminal(term, {
    onExpandImage: (img) =>
      openKittyPicture(
        img,
        'Shell',
        () => shellAlive,
        () => term.focus(),
        expanded,
      ),
  });
  const pixel = attachPixelScroll(term);

  let opened = false;
  let shared = false;
  let lastSentSize = '';
  let ptyCols = 0;
  let ptyRows = 0;
  const pendingSizes: string[] = [];
  let box: { width: number; height: number } | undefined;
  let boxChanged = false;
  const offQueries = suppressMirrorQueries(term);
  const focus = focusReports();
  let mirror: TerminalMirror | undefined;

  const sendSize = (typing = false) => {
    if (!mirror?.ready || !opened || !net.up || !host.clientWidth || !host.clientHeight) return;
    if (typing || boxChanged) shared = false;
    boxChanged = false;
    if (!typing && shared) {
      if (ptyCols !== term.cols || ptyRows !== term.rows) term.resize(ptyCols, ptyRows);
      return;
    }
    try {
      const size = fit.proposeDimensions();
      if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return;
      term.resize(Math.max(20, Math.min(400, size.cols)), Math.max(5, Math.min(200, size.rows)));
    } catch {
      return;
    }
    const key = `${term.cols}x${term.rows}`;
    if ((pendingSizes.length || ptyCols !== term.cols || ptyRows !== term.rows) && key !== lastSentSize) {
      lastSentSize = key;
      pendingSizes.push(key);
      shared = false;
      net.send({ t: 'shell.resize', cols: term.cols, rows: term.rows });
    }
  };

  mirror = new TerminalMirror(
    term,
    (snapshot) => {
      shared = snapshot.shared === true;
      const focusIn = focus.reset(document.hasFocus() && document.activeElement === term.textarea, term.modes.sendFocusMode);
      if (focusIn) net.send({ t: 'shell.input', data: focusIn });
      ptyCols = snapshot.cols;
      ptyRows = snapshot.rows;
      lastSentSize = '';
      pendingSizes.length = 0;
      sendSize();
      scrollAtOnce(term, () => term.scrollToBottom());
    },
    () => net.send({ t: 'shell.attach' }),
  );
  const onMsg = (msg: ServerMsg) => {
    if (msg.t === 'term.data' && msg.workerId === OFFICE_SHELL_ID) mirror?.data(msg.data);
    else if (msg.t === 'term.snapshot' && msg.workerId === OFFICE_SHELL_ID) {
      shared = msg.shared === true;
      ptyCols = msg.cols;
      ptyRows = msg.rows;
      mirror?.snapshot(msg);
    }
  };
  listeners.add(onMsg);
  // Another window typed and changed the size: follow it, unless this one just sent that size.
  const unsub = store.on('screens', (changedId) => {
    if (changedId && changedId !== OFFICE_SHELL_ID) return;
    const s = store.screens.get(OFFICE_SHELL_ID);
    if (!s || !mirror?.ready) return;
    if (s.cols === ptyCols && s.rows === ptyRows) return;
    ptyCols = s.cols;
    ptyRows = s.rows;
    const acknowledged = pendingSizes.indexOf(`${ptyCols}x${ptyRows}`);
    if (acknowledged >= 0) {
      pendingSizes.splice(0, acknowledged + 1);
      return;
    }
    if (`${ptyCols}x${ptyRows}` === lastSentSize) return;
    shared = true;
    term.resize(ptyCols, ptyRows);
    lastSentSize = '';
    pendingSizes.length = 0;
  });
  const ro = new ResizeObserver(([entry]) => {
    if (!entry) return;
    const { width, height } = entry.contentRect;
    if (width <= 0 || height <= 0) return;
    if (box && (width !== box.width || height !== box.height)) boxChanged = true;
    box = { width, height };
    sendSize();
  });

  const modal = openModal(el, {
    backdropCloses: true,
    escCloses: (e) => {
      if (e.shiftKey || !host.contains(document.activeElement)) return true;
      if (!escHinted) {
        escHinted = true;
        hintToast('Esc went to the terminal. Shift+Esc or Ctrl+] leaves it');
      }
      return false;
    },
    doing: '💻 in the shell',
    onClose: () => {
      shellAlive = false;
      listeners.delete(onMsg);
      unsub();
      offQueries();
      mirror?.disconnect();
      offFont();
      offPrefs();
      ro.disconnect();
      net.send({ t: 'shell.detach' });
      term.dispose();
      if (current?.modal === modal) current = null;
    },
  });
  current = { workerId: OFFICE_SHELL_ID, modal, find: () => {}, streams: () => true };
  const paintZoom = (px: number) => {
    smaller.toggleAttribute('disabled', px <= TERM_FONT_MIN);
    bigger.toggleAttribute('disabled', px >= TERM_FONT_MAX);
    zoom.title = `Text size ${px} px`;
  };
  paintZoom(termFontSize());
  const offFont = onTermFontSize((px) => {
    term.options.fontSize = px;
    paintZoom(px);
    boxChanged = true;
    sendSize();
  });
  const offPrefs = followTerminalPrefs(term, {
    resized: () => {
      boxChanged = true;
      sendSize();
    },
  });
  const zoomBy = (dir: 1 | -1) => {
    setTermFontSize(stepTermFont(term.options.fontSize ?? termFontSize(), dir));
    term.focus();
  };
  smaller.addEventListener('click', () => zoomBy(-1));
  bigger.addEventListener('click', () => zoomBy(1));
  closeBtn.addEventListener('click', () => modal.close());

  term.attachCustomKeyEventHandler((e) => {
    if (e.ctrlKey && e.key === ']') {
      if (e.type === 'keydown') modal.close();
      return false;
    }
    if (e.key === 'Escape' && e.shiftKey) return false;
    const action = kitty.keyAction(e, false);
    if (action.do === 'default') return !pixel.handleKey(e);
    if (action.do === 'send') {
      e.preventDefault();
      term.input(action.data);
    }
    return false;
  });
  term.onData((data) => {
    if (!mirror?.ready || !net.up) return;
    const kind = focus.classify(data);
    if (kind === 'repeat') return;
    if (kind === 'input') sendSize(true);
    net.send({ t: 'shell.input', data });
  });

  let uploading = 0;
  const insertFiles = async (files: File[]) => {
    if (!files.length) return;
    el.classList.toggle('uploading', ++uploading > 0);
    try {
      const paths = await Promise.all(files.map((f) => uploadDrop(OFFICE_SHELL_ID, f)));
      if (current?.modal !== modal) return;
      sendSize(true);
      term.paste(droppedPaths(paths));
      term.focus();
    } catch (err) {
      toast((err as Error).message, 'warn');
    } finally {
      el.classList.toggle('uploading', --uploading > 0);
    }
  };
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  let dragDepth = 0;
  const dragEnd = () => {
    dragDepth = 0;
    el.classList.remove('dropping');
  };
  modal.backdrop.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    el.classList.add('dropping');
  });
  modal.backdrop.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  modal.backdrop.addEventListener('dragleave', (e) => {
    if (hasFiles(e) && --dragDepth <= 0) dragEnd();
  });
  modal.backdrop.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragEnd();
    void insertFiles([...e.dataTransfer!.files]);
  });
  host.addEventListener(
    'paste',
    (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length || e.clipboardData?.getData('text/plain')) return;
      e.preventDefault();
      e.stopPropagation();
      void insertFiles(files);
    },
    true,
  );

  void loadFonts().then(() => {
    if (current?.modal !== modal) return;
    term.open(host);
    opened = true;
    ro.observe(host);
    net.send({ t: 'shell.attach' });
    setTimeout(() => {
      if (current?.modal === modal) term.focus();
    }, 50);
  });
}
