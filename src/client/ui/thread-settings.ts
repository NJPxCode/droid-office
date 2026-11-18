import type { AgentEffort, ClientMsg } from '../../shared/protocol';
import { h } from './dom';
import { droidCatalogue, EFFORT_LABEL, type DroidModelOption } from './models';
import { effortLabel, type LiveSettings } from './thread-live-view';

interface MenuItem {
  label: string;
  current: boolean;
  /** Absent for a row that only informs. */
  pick?: () => void;
}

export interface ThreadSettingsOptions {
  workerId: () => string;
  send: (msg: ClientMsg) => Promise<string | undefined>;
  /** Shows why a change failed, under the composer. */
  told: (text: string) => void;
}

export interface ThreadSettings {
  chips: HTMLElement[];
  menu: HTMLElement;
  readonly isOpen: boolean;
  /** Repaints the model chip; `editable` is false where the Thread cannot change session settings (a cloud worker). */
  paint(settings: LiveSettings | undefined, editable: boolean): void;
  close(): void;
  dispose(): void;
}

/**
 * The composer's model and reasoning-effort chip. Clicking it opens a menu that updates the live
 * daemon session settings (`worker.setting`).
 */
export function mountThreadSettings(opts: ThreadSettingsOptions): ThreadSettings {
  let settings: LiveSettings | undefined;
  let editable = false;
  let open = false;
  let changing = false;
  let models: DroidModelOption[] | undefined;
  let unlisted = false;
  const modelChip = h('button.wt-setting.wt-model', { type: 'button', hidden: true, 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Model and reasoning effort', onclick: () => toggle() });
  const menu = h('div.wt-recent.wt-settings-menu', { role: 'menu', 'aria-label': 'Model and reasoning effort', hidden: true });

  const change = async (setting: 'effort' | 'model', value: string) => {
    close();
    if (changing) return;
    changing = true;
    paintChips();
    let why: string | undefined;
    try {
      why = await opts.send({ t: 'worker.setting', workerId: opts.workerId(), setting, value });
    } catch (err) {
      why = (err instanceof Error ? err.message : String(err)) || 'Could not change the setting';
    } finally {
      changing = false;
      paintChips();
    }
    if (why) opts.told(why);
  };

  const sections = (): { title: string; items: MenuItem[] }[] => {
    const out: { title: string; items: MenuItem[] }[] = [];
    const efforts: AgentEffort[] = models?.find((model) => model.id === settings?.model)?.supportedReasoningEfforts ?? [];
    if (efforts.length > 1) {
      out.push({ title: 'Reasoning effort', items: efforts.map((effort) => ({ label: EFFORT_LABEL[effort], current: settings?.reasoningEffort === effort, pick: () => void change('effort', effort) })) });
    }
    if (!models) out.push({ title: 'Model', items: [{ label: unlisted ? 'Could not load Droid models' : 'Loading Droid models…', current: false }] });
    else {
      const offered = models.filter((model) => !model.legacy || model.id === settings?.model);
      out.push({ title: 'Model', items: offered.map((model) => ({ label: model.displayName, current: model.id === settings?.model, pick: () => void change('model', model.id) })) });
    }
    return out;
  };

  const paintMenu = () => {
    menu.hidden = !open;
    modelChip.setAttribute('aria-expanded', String(open));
    if (!open) {
      menu.replaceChildren();
      return;
    }
    menu.replaceChildren(
      ...sections().flatMap((section) => [
        h('div.wt-recent-title', {}, section.title),
        ...section.items.map((item) =>
          h(
            'button.wt-recent-item.wt-settings-item',
            { type: 'button', role: 'menuitemradio', 'aria-checked': String(item.current), disabled: !item.pick, onmousedown: (event: Event) => event.preventDefault(), onclick: item.pick },
            item.label,
          ),
        ),
      ]),
    );
    (menu.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu.querySelector<HTMLElement>('button'))?.scrollIntoView({ block: 'nearest' });
  };

  const toggle = () => {
    if (!editable || changing) return;
    open = !open;
    if (open && !models) {
      unlisted = false;
      // A failed load is tried again the next time the menu opens.
      void droidCatalogue()
        .then(
          (catalogue) => {
            models = catalogue.models;
          },
          () => {
            unlisted = true;
          },
        )
        .finally(() => paintMenu());
    }
    paintMenu();
  };

  const close = () => {
    if (!open) return;
    open = false;
    paintMenu();
  };

  const outside = (event: PointerEvent) => {
    if (!open || !(event.target instanceof Node)) return;
    if (!menu.contains(event.target) && !modelChip.contains(event.target)) close();
  };
  document.addEventListener('pointerdown', outside, true);
  const keys = (event: KeyboardEvent) => {
    if (!open) return;
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      modelChip.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!buttons.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = at < 0 ? (step > 0 ? 0 : buttons.length - 1) : (at + step + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  };
  menu.addEventListener('keydown', keys);
  modelChip.addEventListener('keydown', keys);

  const paintChips = () => {
    const model = settings?.modelName ?? settings?.model;
    const rawEffort = effortLabel(settings?.reasoningEffort);
    const effort = rawEffort && !model?.toLowerCase().includes(rawEffort.toLowerCase()) ? rawEffort : undefined;
    modelChip.hidden = !model;
    if (model) modelChip.replaceChildren(h('span', {}, model), effort ? h('span.wt-model-effort', {}, effort) : '');
    modelChip.disabled = editable && changing;
    modelChip.classList.toggle('fixed', !editable);
    modelChip.setAttribute('aria-busy', String(changing));
  };

  return {
    chips: [modelChip],
    menu,
    get isOpen() {
      return open;
    },
    paint(next, canEdit) {
      settings = next;
      editable = canEdit;
      if (!editable) close();
      paintChips();
      if (open) paintMenu();
    },
    close,
    dispose() {
      document.removeEventListener('pointerdown', outside, true);
      menu.removeEventListener('keydown', keys);
      modelChip.removeEventListener('keydown', keys);
    },
  };
}
