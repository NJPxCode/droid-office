import { h, openModal, toast } from './dom';
import { icon } from './icons';

export function openThreadRewind(opts: { busy: boolean; send: (restore: 'files' | 'conversation') => Promise<string | undefined> }) {
  if (opts.busy) {
    toast('Rewind is only available while Droid is idle.', 'warn');
    return;
  }
  let restore: 'files' | 'conversation' = 'conversation';
  let sending = false;
  const error = h('p.wt-rewind-error.note.bad', { role: 'alert', hidden: true });
  const back = h('button.btn.ghost', { type: 'button', onclick: () => modal.close() }, 'Back');
  const confirm = h('button.btn.primary', { type: 'button' }, 'Rewind');
  const choice = (value: 'files' | 'conversation', title: string, description: string, checked: boolean) => {
    const radio = h('input', { type: 'radio', name: 'wt-rewind-restore', value, checked, onchange: () => (restore = value) });
    return h('label.choice.wt-rewind-choice', {}, radio, h('span.choice-text', {}, h('b', {}, title), h('small', {}, description)));
  };
  const content = h(
    'div.modal.sm.wt-rewind',
    { role: 'dialog', 'aria-label': 'Rewind Conversation' },
    h('header', {}, h('div.titles', {}, h('h2', {}, 'Rewind Conversation'))),
    h(
      'div.body.stack',
      {},
      h('p', {}, 'Are you sure you want to rewind to this message? Changed files will not be reverted.'),
      h(
        'div.choices.rows',
        { role: 'radiogroup', 'aria-label': 'Rewind File Restoration' },
        choice('conversation', "Don't restore files", 'Rewind the conversation only. Keep every file as it is now.', true),
        choice('files', 'Restore all files', 'Also restore the files this turn changed to how they were at this message.', false),
      ),
      error,
    ),
    h('footer', {}, h('span.grow'), back, confirm),
  );
  const modal = openModal(content, { doing: 'rewinding a conversation' });
  confirm.addEventListener('click', async () => {
    if (sending) return;
    sending = true;
    error.hidden = true;
    confirm.disabled = back.disabled = true;
    confirm.replaceChildren(h('span.spinner', { 'aria-hidden': 'true' }), 'Rewinding…');
    const why = await opts.send(restore);
    if (!why) {
      modal.close();
      return;
    }
    sending = false;
    error.textContent = why || 'Failed to rewind conversation';
    error.hidden = false;
    confirm.disabled = back.disabled = false;
    confirm.replaceChildren(icon('back', 14), 'Rewind');
  });
}
