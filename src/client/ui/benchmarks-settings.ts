import { ARTIFICIAL_ANALYSIS_KEYS_URL, ARTIFICIAL_ANALYSIS_URL } from '../../shared/benchmarks';
import { AIRGAPPED_REASON } from '../../shared/setup';
import type { Net } from '../net';
import { store } from '../state';
import { h, timeAgo } from './dom';

/**
 * ⚙️ Settings → Connections → "Artificial Analysis": connects a Data API key (kept in mode 0600
 * `.droid-office/artificial-analysis.json`) so team_models shows each model's public benchmarks.
 */
export function benchmarksSettings(net: Net): { card: { desc: Node; below: Node[] }; dispose: () => void } {
  const keyInput = h('input.input', {
    type: 'password',
    placeholder: 'aa_…',
    'aria-label': 'Artificial Analysis API key',
    spellcheck: 'false',
    autocomplete: 'new-password',
  }) as HTMLInputElement;
  const connect = h('button.btn.primary', { type: 'button' }, 'Connect') as HTMLButtonElement;
  const cancel = h('button.btn.ghost', { type: 'button' }, 'Cancel');
  const form = h('div.row.wrap', {}, h('div.input-group.grow', {}, keyInput, connect), cancel);

  const intro = h(
    'small.factory-intro',
    {},
    'Shows leads and the Orchestrator each model’s intelligence, engineering score and token spend at every reasoning effort in team_models, from ',
    h('a', { href: ARTIFICIAL_ANALYSIS_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Artificial Analysis'),
    '. A free key is enough; the office reads the list once a day. Get one at ',
    h('a', { href: ARTIFICIAL_ANALYSIS_KEYS_URL, target: '_blank', rel: 'noopener noreferrer' }, 'artificialanalysis.ai'),
    '; it stays on this machine.',
  );
  const who = h('span.factory-who');
  const facts = h('span.setting-meta');
  const summary = h('small.stack.tight', {}, who, facts);
  const error = h('p.note.bad', { role: 'alert' });
  const lastError = h('p.note.warn');

  const refresh = h('button.btn.sm', { type: 'button' }, 'Read now') as HTMLButtonElement;
  const replace = h('button.btn.sm', { type: 'button' }, 'Replace key') as HTMLButtonElement;
  const remove = h('button.btn.sm.danger', { type: 'button' }, 'Disconnect') as HTMLButtonElement;
  const actions = h('div.row.wrap', {}, refresh, replace, remove);
  const modeNote = h('p.note.info', {}, AIRGAPPED_REASON, ' Existing credentials are kept.');

  let busy = false;
  let replacing = false;
  let failure = '';

  const paint = () => {
    modeNote.classList.toggle('hidden', !store.setup.airgapped);
    if (store.setup.airgapped) {
      for (const el of [intro, summary, form, error, lastError, actions]) el.classList.add('hidden');
      return;
    }
    const b = store.benchmarks;
    const editing = !b.connected || replacing;
    for (const el of [summary, actions]) el.classList.toggle('hidden', editing);
    form.classList.toggle('hidden', !editing);
    intro.classList.toggle('hidden', !editing);
    cancel.classList.toggle('hidden', !b.connected);
    connect.disabled = busy;
    connect.textContent = busy ? 'Reading…' : b.connected ? 'Use this key' : 'Connect';
    keyInput.disabled = busy;
    error.classList.toggle('hidden', !failure);
    error.textContent = failure;
    lastError.classList.toggle('hidden', !b.connected || editing || !b.error);
    lastError.textContent = b.error ? `Last read failed: ${b.error} The benchmarks from before stay in use.` : '';
    if (!b.connected) return;
    who.textContent = `${b.models.toLocaleString()} model ${b.models === 1 ? 'family' : 'families'} benchmarked`;
    facts.textContent = [b.fingerprint ? `Key …${b.fingerprint}` : '', b.checking ? 'reading now…' : b.fetchedAt ? `read ${timeAgo(b.fetchedAt)}` : ''].filter(Boolean).join(' · ');
    const locked = busy || Boolean(b.checking);
    for (const btn of [refresh, replace, remove]) btn.disabled = locked;
    refresh.textContent = b.checking ? 'Reading…' : 'Read now';
  };

  const send = () => {
    const key = keyInput.value.trim();
    if (!key) return keyInput.focus();
    busy = true;
    failure = '';
    net.send({ t: 'benchmarks.connect', key });
    paint();
  };
  connect.addEventListener('click', send);
  keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
  cancel.addEventListener('click', () => {
    replacing = false;
    failure = '';
    keyInput.value = '';
    paint();
  });
  replace.addEventListener('click', () => {
    replacing = true;
    failure = '';
    paint();
    keyInput.focus();
  });
  refresh.addEventListener('click', () => {
    failure = '';
    net.send({ t: 'benchmarks.refresh' });
  });
  remove.addEventListener('click', () => {
    if (confirm('Disconnect Artificial Analysis? The office forgets the key and team_models stops showing benchmarks.')) net.send({ t: 'benchmarks.disconnect' });
  });

  const offSetup = net.onMessage((msg) => {
    if (msg.t !== 'benchmarks.setup') return;
    if (busy) {
      busy = false;
      failure = msg.error ?? '';
      if (msg.ok) {
        replacing = false;
        keyInput.value = '';
      }
    }
    paint();
  });
  const offState = store.on('benchmarks', paint);
  const offMode = store.on('setup', paint);
  const timer = setInterval(paint, 30_000);
  paint();

  return {
    card: { desc: h('span.stack.tight', {}, intro, summary), below: [modeNote, form, error, lastError, actions] },
    dispose: () => {
      offSetup();
      offState();
      offMode();
      clearInterval(timer);
    },
  };
}
