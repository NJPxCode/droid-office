import { sameMenu, type Menu } from '../../shared/asks';
import { pendingQuestions, questionPresentation, replySummary } from '../../shared/ask-question';
import type { ClientMsg, WorkerInfo } from '../../shared/protocol';
import type { ThreadEntry } from '../../shared/worker-thread';
import { store } from '../state';
import { h, toast } from './dom';
import { icon } from './icons';
import type { openQuestionWorkspace, QuestionDraft, QuestionReply } from './question-workspace';

/** Structured AskUser menu held by the local or cloud daemon for a waiting Droid session. */
export function activeWorkerMenu(w: WorkerInfo | undefined): Menu | undefined {
  if (w?.status !== 'needs_input' || w.kind === 'shell') return undefined;
  return w.menu ?? w.cloud?.menu;
}

export interface QuestionSlotOptions {
  element?: HTMLElement;
  worker(): WorkerInfo | undefined;
  entries(): readonly ThreadEntry[];
  live(): boolean;
  busy?(workerId: string): boolean;
  usable?(workerId: string): boolean;
  readDraft?(workerId: string): string;
  saveDraft?(workerId: string, text: string): void;
  send(msg: Extract<ClientMsg, { t: 'worker.answer' }>, workerId: string): Promise<string | undefined>;
}

export interface QuestionSlot {
  readonly element: HTMLElement;
  paint(review?: boolean): void;
  reset(workerId?: string): void;
  dispose(): void;
}

/**
 * Interactive AskUser question card inside a worker's Thread (3D desk, Orchestrator, cloud window,
 * and `/dashboard` pane), backed by `openQuestionWorkspace` across multi-question questionnaires.
 */
export function createQuestionSlot(opts: QuestionSlotOptions): QuestionSlot {
  const element = opts.element ?? h('section.dash-question', { 'aria-label': 'Question requiring input', hidden: true });
  let id = '';
  let disposed = false;
  let shownMenu: Menu | undefined;
  let questionKey = '';
  let questionDraft: QuestionDraft = { text: '' };
  let questionWorkspace: ReturnType<typeof openQuestionWorkspace> | undefined;
  let series = { key: '', answers: {} as Record<number, string> };
  let answered = false;
  let questionReplying = false;
  let answerSettlesAt = 0;

  function reset(next = '') {
    questionWorkspace?.close();
    questionWorkspace = undefined;
    id = next;
    shownMenu = undefined;
    questionKey = '';
    questionDraft = { text: next ? (opts.readDraft?.(next) ?? '') : '' };
    series = { key: '', answers: {} };
    answered = false;
    questionReplying = false;
    answerSettlesAt = 0;
    element.hidden = true;
    element.replaceChildren();
  }

  function paint(review = false) {
    if (disposed) return;
    const w = opts.worker();
    if ((w?.id ?? '') !== id) reset(w?.id ?? '');
    if (!w) return;
    if (w.status !== 'needs_input' && element.hidden && !shownMenu && !questionWorkspace && !questionReplying && Date.now() >= answerSettlesAt) return;
    const next = activeWorkerMenu(w);
    if (w.status !== 'needs_input') {
      shownMenu = undefined;
      answered = false;
    }
    // The workspace follows the questionnaire: after an answer, or when the owner hasn't started on the
    // shown question (it was answered elsewhere), the next menu replaces it. A started draft waits.
    const untouched = !questionDraft.text.trim() && questionDraft.choices === undefined;
    if ((!shownMenu && next) || review || (next && !questionReplying && !sameMenu(shownMenu, next) && (answered || untouched))) {
      shownMenu = next;
      answered = false;
      questionDraft.choices = undefined;
    }
    const current = sameMenu(shownMenu, next);
    const settling = questionReplying || Date.now() < answerSettlesAt;
    const entries = opts.entries();
    const asked = JSON.stringify(pendingQuestions(entries, w.ask).map((q) => [q.question, q.options]));
    if (asked !== series.key) series = { key: asked, answers: {} };
    const display = shownMenu && questionPresentation(shownMenu, entries, w.ask);
    const supported = !shownMenu?.multiSelect || store.workerAnswerMultiSelect || Boolean(w.menu || w.cloud?.menu);
    const live = opts.live();
    const isBusy = opts.busy?.(w.id) ?? false;
    const enabled = live && supported && current && !isBusy && !answered && !questionReplying;
    const qs = shownMenu && { menu: shownMenu, entries, ask: w.ask, answers: series.answers, hasReview: Boolean(shownMenu.review), enabled, supported, sending: questionReplying, answered, current, connected: live };
    if (qs) questionWorkspace?.update(qs);
    else if (questionWorkspace && !settling) questionWorkspace.close();
    const key = JSON.stringify([shownMenu, display, current, supported, live, isBusy, answered, questionReplying, settling, w.status]);
    if (key === questionKey) return;
    questionKey = key;
    element.hidden = !shownMenu && w.status !== 'needs_input';
    if (!shownMenu) {
      if (settling) {
        element.replaceChildren(h('div.dash-question-card.quiet', { role: 'status' }, h('p', {}, questionReplying ? 'Sending your answer…' : 'Answer sent. Waiting for the worker’s next move.')));
        return;
      }
      element.replaceChildren(
        h(
          'div.dash-question-card.quiet',
          {},
          h('span.dash-question-icon', {}, icon('alert', 16)),
          h('p', {}, h('b', {}, `${w.name} needs you. `), w.cloud ? 'The office can’t answer this one from here: open its Factory session.' : w.kind === 'shell' ? 'Answer it in the terminal below.' : 'Waiting for the question from Droid…'),
        ),
      );
      return;
    }
    const menu = shownMenu;
    const targetId = w.id;
    const reply = async (value: QuestionReply, answerMenu: Menu) => {
      if (disposed || !opts.live() || questionReplying || answered || opts.usable?.(targetId) === false) return;
      questionReplying = true;
      questionKey = '';
      paint();
      const error = await opts.send({ t: 'worker.answer', workerId: targetId, menu: answerMenu, ...value }, targetId);
      if (disposed || id !== targetId) return;
      questionReplying = false;
      if (error) {
        answerSettlesAt = 0;
        toast(error, 'warn');
      } else {
        const latest = opts.worker();
        const sent = questionPresentation(answerMenu, opts.entries(), latest?.ask ?? w.ask);
        if (sent.position) series.answers = { ...series.answers, [sent.position]: replySummary(sent, value) };
        answered = true;
        const until = Date.now() + 3000;
        answerSettlesAt = until;
        setTimeout(() => {
          if (disposed || id !== targetId || answerSettlesAt !== until) return;
          questionKey = '';
          paint();
        }, 3000);
        questionDraft.text = '';
        questionDraft.choices = undefined;
        opts.saveDraft?.(targetId, '');
      }
      questionKey = '';
      paint();
    };
    element.replaceChildren(
      h(
        'div.dash-question-card',
        {},
        h('div.dash-question-top', {}, h('span.eyebrow', {}, `${w.name} needs your answer`), answered ? h('span.pill.done', {}, 'Sent') : null),
        h('h3.dash-question-preview', {}, display?.question ?? menu.question ?? 'Choose an answer'),
        h(
          'div.dash-question-summary',
          {},
          menu.review
            ? 'Review and submit your answers to continue'
            : `${display?.position ? `Question ${display.position} of ${display.total} · ` : ''}${menu.multiSelect ? 'Select all that apply' : 'Select one answer'} · ${menu.choices.length} options`,
        ),
        h(
          'button.btn.accent',
          {
            type: 'button',
            disabled: !live || questionReplying,
            onclick: () => {
              if (questionWorkspace || !qs) return;
              void import('./question-workspace').then(({ openQuestionWorkspace }) => {
                if (disposed || questionWorkspace || !qs || id !== targetId) return;
                questionWorkspace = openQuestionWorkspace({
                  name: w.name,
                  state: qs,
                  draft: questionDraft,
                  onDraft: () => opts.saveDraft?.(targetId, questionDraft.text),
                  reply,
                  review: () => {
                    questionKey = '';
                    paint(true);
                  },
                  onClose: () => {
                    questionWorkspace = undefined;
                  },
                });
              });
            },
          },
          answered ? 'View answer status' : menu.review ? 'Review answers' : 'Answer questions',
        ),
        questionReplying
          ? h('p.note.info', {}, 'Sending your answer…')
          : answered
            ? h('p.note.info', {}, 'Answer sent. Waiting for the worker’s next move.')
            : !current
              ? h('p.note.warn', {}, 'The question changed or was answered elsewhere. Your text is kept; look at the current question before sending anything.')
              : null,
        !current && next
          ? h(
              'button.btn',
              {
                type: 'button',
                onclick: () => {
                  questionKey = '';
                  paint(true);
                },
              },
              'Show the current question',
            )
          : null,
      ),
    );
  }

  return {
    element,
    paint,
    reset,
    dispose() {
      disposed = true;
      questionWorkspace?.close();
      questionWorkspace = undefined;
    },
  };
}
