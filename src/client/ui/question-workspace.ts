import { menuTakesText, type Menu } from '../../shared/asks';
import { pendingQuestions, questionPresentation, questionSteps, reviewAnswers, type QuestionStep } from '../../shared/ask-question';
import type { ThreadEntry } from '../../shared/worker-thread';
import type { WorkerAsk } from '../../shared/protocol';
import { h, openModal } from './dom';
import { windowHeader } from './kit';

export interface QuestionDraft {
  text: string;
  choices?: number[];
}
export interface QuestionState {
  menu: Menu;
  entries: readonly ThreadEntry[];
  /** The worker's pending ask from its hooks, which has the whole text (see WorkerInfo.ask). */
  ask?: WorkerAsk;
  /** What this client sent for earlier questions of the same questionnaire, by 1-based position. */
  answers?: Readonly<Record<number, string>>;
  /** Whether the questionnaire ends with Droid's terminal Review screen (cloud workers send on the last question). */
  hasReview?: boolean;
  enabled: boolean;
  sending: boolean;
  answered: boolean;
  current: boolean;
  connected: boolean;
  supported?: boolean;
}
export type QuestionReply = { choice?: number; choices?: number[]; text?: string };

/** Enter right after the next question appears belongs to the previous one, not to this one. */
const SETTLE_MS = 400;

function feedbackMessage(state: QuestionState, name: string, hasRaw: boolean, at: number, questionCount: number, following?: QuestionStep): string {
  if (state.sending) return 'Sending your answer…';
  if (state.answered) {
    if (state.menu.review || !following) return `Sent. ${name} is continuing.`;
    if (following.review) return 'Answer sent. Opening the review…';
    return `Answer sent. Opening question ${at + 2} of ${questionCount}…`;
  }
  if (!state.connected) return 'Disconnected. Your draft is kept. Nothing will be sent automatically.';
  if (state.supported === false) {
    return hasRaw ? 'This office version cannot safely submit checkbox answers. Update the host, or use Raw TTY.' : 'This office version cannot safely submit checkbox answers. Update the host.';
  }
  if (!state.current) return 'This question changed or was answered elsewhere. Review the current question before sending.';
  return 'Your draft stays here if you go back to the thread.';
}

/**
 * One scrollable answer surface for a whole questionnaire, with pinned navigation and submit
 * controls. It follows the worker from question to question (update) until the series ends.
 */
export function openQuestionWorkspace(opts: { name: string; state: QuestionState; draft: QuestionDraft; onDraft(): void; reply(value: QuestionReply, menu: Menu): Promise<void>; review(): void; raw?(): void; onClose(): void }) {
  let state = opts.state;
  let key = '';
  let stepsKey = '';
  let steps: QuestionStep[] = [];
  let selected = new Set<number>();
  let submitting = false;
  let movedAt = 0;
  const previousFocus = document.activeElement;
  const stepBar = h('ol.qw-steps', { 'aria-label': 'Questions' });
  const body = h('div.body.qw-body');
  const feedback = h('p.qw-feedback', { role: 'status', 'aria-live': 'polite' });
  const count = h('span.qw-count');
  const keys = h('span.qw-keys', { 'aria-hidden': 'true' }, '1–9 pick · Enter submits');
  const submit = h('button.btn.accent', { type: 'submit' }, 'Submit answer');
  const review = h('button.btn', { type: 'button', onclick: opts.review, hidden: true }, 'Show current question');
  const raw = opts.raw
    ? h(
        'button.btn.ghost',
        {
          type: 'button',
          onclick: () => {
            modal.close();
            opts.raw?.();
          },
        },
        'Raw TTY',
      )
    : null;
  const back = h('button.btn.ghost', { type: 'button', onclick: () => modal.close() }, 'Back to thread');
  const form = h(
    'form.modal.question-workspace',
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Answer questions' },
    windowHeader('Answer questions', `${opts.name} is waiting for your answer`),
    stepBar,
    body,
    h('div.qw-feedback-row', {}, feedback, review),
    h('footer', {}, h('div.grow.qw-footer-meta', {}, count, keys, raw), back, submit),
  );
  const modal = openModal(form, {
    size: 'lg',
    onClose: () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
      opts.onClose();
    },
  });
  const locked = () => !state.enabled || state.supported === false;
  const updateSelection = () => {
    for (const input of body.querySelectorAll<HTMLInputElement>('input[name="answer-choice"]')) {
      input.checked = selected.has(Number(input.value));
      input.closest('label')?.classList.toggle('on', input.checked);
    }
    count.textContent = state.menu.review ? 'Final review' : state.menu.multiSelect ? `${selected.size} selected` : selected.size ? '1 answer selected' : 'Choose an answer';
    const hasText = !!opts.draft.text.trim();
    submit.disabled = submitting || locked() || (!state.menu.review && !selected.size && !hasText);
  };
  const paintSteps = () => {
    const next = JSON.stringify(steps);
    if (next === stepsKey) return;
    stepsKey = next;
    stepBar.hidden = !steps.length;
    stepBar.replaceChildren(
      ...steps.map((step, index) =>
        h(
          'li.qw-step',
          { 'data-state': step.state, 'aria-current': step.state === 'current' ? 'step' : undefined, title: step.answer ? `${step.label}: ${step.answer}` : step.label },
          h('span.qw-step-mark', { 'aria-hidden': 'true' }, step.state === 'done' ? '✓' : String(index + 1)),
          h('span.qw-step-copy', {}, h('span.qw-step-label', {}, step.label), step.state === 'done' ? h('small.qw-step-answer', {}, step.answer ?? 'Answered') : step.state === 'current' ? h('small.qw-step-answer', {}, 'Now') : null),
        ),
      ),
    );
    requestAnimationFrame(() => stepBar.querySelector('[aria-current="step"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  };
  const update = (next: QuestionState) => {
    state = next;
    const display = questionPresentation(state.menu, state.entries, state.ask);
    const asked = questionSteps(state.menu, display, pendingQuestions(state.entries, state.ask), state.answers, state.hasReview ?? true);
    const questionCount = asked.filter((step) => !step.review).length;
    const at = asked.findIndex((step) => step.state === 'current');
    const following = at >= 0 ? asked[at + 1] : undefined;
    // Once sent, the bar moves on before the worker draws its next question.
    steps = asked;
    if (state.answered && following && at >= 0) {
      steps = asked.map((step, index) => {
        if (index === at) return { ...step, state: 'done' as const, ...(state.answers?.[at + 1] ? { answer: state.answers[at + 1] } : {}) };
        if (index === at + 1) return { ...step, state: 'current' as const };
        return step;
      });
    }
    paintSteps();
    const nextKey = JSON.stringify([state.menu.question, state.menu.choices.map((c) => [c.number, c.label, c.description]), state.menu.multiSelect, state.menu.review, display]);
    if (key !== nextKey) {
      const first = !key;
      key = nextKey;
      movedAt = Date.now();
      selected = new Set(opts.draft.choices ?? state.menu.choices.filter((c) => c.selected).map((c) => c.number));
      const instructions = state.menu.multiSelect ? 'Select all that apply' : 'Select one answer';
      const text = h('textarea.input.qw-text', { rows: 3, maxlength: 20000, 'aria-label': 'Your own answer', placeholder: state.menu.multiSelect ? 'Add your own answer (optional)…' : 'Or write your own answer…' });
      text.value = opts.draft.text;
      text.addEventListener('input', () => {
        opts.draft.text = text.value;
        if (!state.menu.multiSelect && text.value.trim()) selected.clear();
        opts.draft.choices = [...selected];
        opts.onDraft();
        updateSelection();
      });
      const pairs = state.menu.review ? reviewAnswers(state.menu.review) : [];
      body.replaceChildren(
        h(
          'div.qw-content',
          {},
          h(
            'div.qw-question-meta',
            {},
            h('span.eyebrow', {}, state.menu.review ? 'Final review' : display.position ? `Question ${display.position} of ${display.total}` : 'Current question'),
            h('span.pill', {}, state.menu.review ? 'Ready to submit' : state.menu.multiSelect ? 'Multiple answers' : 'One answer'),
          ),
          h('h3.qw-question', { id: 'qw-question', tabindex: -1 }, display.question),
          h(
            'p.qw-instructions',
            { id: 'qw-instructions' },
            state.menu.review ? (opts.raw ? 'Check your answers, then submit them to the worker. To edit them, open Raw TTY.' : 'Check your answers, then submit them to the worker.') : `${instructions}. Nothing is sent until you submit.`,
          ),
          state.menu.review
            ? pairs.length && pairs.every((pair) => pair.question)
              ? h('dl.qw-review', {}, ...pairs.map((pair) => h('div.qw-review-row', {}, h('dt', {}, pair.question), h('dd', {}, pair.answer || 'No answer'))))
              : h('div.qw-review.plain', {}, state.menu.review.join('\n'))
            : h(
                'div.qw-choices',
                { role: state.menu.multiSelect ? 'group' : 'radiogroup', 'aria-labelledby': 'qw-question', 'aria-describedby': 'qw-instructions' },
                ...display.choices.map((choice) => {
                  const input = h('input', { type: state.menu.multiSelect ? 'checkbox' : 'radio', name: 'answer-choice', value: choice.number });
                  input.addEventListener('change', () => {
                    if (!state.menu.multiSelect) {
                      selected.clear();
                      text.value = '';
                      opts.draft.text = '';
                    }
                    if (input.checked) selected.add(choice.number);
                    else selected.delete(choice.number);
                    opts.draft.choices = [...selected];
                    opts.onDraft();
                    updateSelection();
                  });
                  return h(
                    'label.qw-choice',
                    {},
                    input,
                    h('span.qw-choice-copy', {}, h('span', {}, choice.label), choice.description ? h('small', {}, choice.description) : null),
                    h('kbd.qw-choice-key', { 'aria-hidden': 'true' }, String(choice.number)),
                  );
                }),
              ),
          menuTakesText(state.menu) ? h('div.field.qw-own-answer', {}, h('label', {}, state.menu.multiSelect ? 'Add an answer' : 'Your own answer'), text) : null,
          !display.complete ? h('p.qw-source-note', {}, opts.raw ? 'Showing the terminal’s readable text. If anything is missing, open Raw TTY.' : 'Showing the question’s readable text.') : null,
        ),
      );
      body.scrollTop = 0;
      keys.hidden = !!state.menu.review;
      // A new question takes focus only from this window (or from nowhere), never from elsewhere on the page.
      const active = document.activeElement;
      if (first || !active || active === document.body || !active.isConnected || form.contains(active))
        requestAnimationFrame(() => {
          const target = state.menu.review ? body.querySelector<HTMLElement>('#qw-question') : body.querySelector<HTMLInputElement>('input:enabled');
          (target ?? back).focus({ preventScroll: true });
        });
    }
    for (const input of body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) input.disabled = locked();
    feedback.textContent = feedbackMessage(state, opts.name, Boolean(opts.raw), at, questionCount, following);
    review.hidden = state.current || state.sending || state.answered || !state.connected;
    submit.textContent = state.sending ? 'Sending…' : state.menu.review ? 'Submit answers' : following ? 'Submit and continue' : 'Submit answer';
    updateSelection();
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const text = opts.draft.text.trim();
    submitting = true;
    updateSelection();
    let payload: QuestionReply;
    if (state.menu.review) payload = { choice: 1 };
    else if (state.menu.multiSelect) payload = { choices: [...selected], ...(text ? { text } : {}) };
    else if (text) payload = { text };
    else payload = { choice: [...selected][0] };
    void opts.reply(payload, state.menu).finally(() => {
      submitting = false;
      updateSelection();
    });
  });
  form.addEventListener('keydown', (event) => {
    const target = event.target;
    const onChoice = target instanceof HTMLInputElement && ['radio', 'checkbox'].includes(target.type);
    if (event.key === 'Enter' && !event.isComposing) {
      const fromText = target instanceof HTMLTextAreaElement && (event.metaKey || event.ctrlKey);
      if (!onChoice && !fromText) return;
      event.preventDefault();
      if (Date.now() - movedAt >= SETTLE_MS) form.requestSubmit();
      return;
    }
    const typing = target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && !onChoice);
    if (/^[1-9]$/.test(event.key) && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const input = body.querySelector<HTMLInputElement>(`input[name="answer-choice"][value="${event.key}"]:enabled`);
      if (!input) return;
      event.preventDefault();
      input.focus({ preventScroll: true });
      if (input.type === 'checkbox' || !input.checked) input.click();
      input.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [...form.querySelectorAll<HTMLElement>('button:enabled, input:enabled, textarea:enabled')].filter((control) => control.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
  update(state);
  return { update, close: () => modal.close() };
}
