import type { Menu } from './asks.js';
import type { AskedQuestion, WorkerAsk } from './protocol.js';
import type { ThreadEntry } from './worker-thread.js';

export type { AskedQuestion };

/** AskUser's own questionnaire format: `1. [question] …`, `[topic] …`, `[option] …`, `(multi)` at the end of a question. */
export function parseQuestionnaire(text: string): AskedQuestion[] {
  const questions: AskedQuestion[] = [];
  let current: AskedQuestion | undefined;
  let continuing: 'question' | 'option' | undefined;
  for (const line of text.split('\n')) {
    const question = /^\s*(?:\d+[.)]\s*)?\[question]\s*(.+)$/.exec(line);
    const option = /^\s*\[option]\s*(.+)$/.exec(line);
    const topic = /^\s*\[topic]\s*(.*)$/.exec(line);
    if (question) {
      current = { question: question[1].replace(/\s*\(multi\)\s*$/i, '').trim(), options: [], multiSelect: /\(multi\)\s*$/i.test(question[1]) };
      questions.push(current);
      continuing = 'question';
    } else if (option && current) {
      current.options.push(option[1].trim());
      continuing = 'option';
    } else if (topic) {
      if (current && topic[1].trim()) current.topic = topic[1].trim();
      continuing = undefined;
    } else if (current && continuing === 'option') current.options[current.options.length - 1] += `\n${line}`;
    else if (current && continuing === 'question') {
      if (/\(multi\)\s*$/i.test(line)) current.multiSelect = true;
      const continued = line.replace(/\s*\(multi\)\s*$/i, '').trim();
      current.question += `\n${continued}`;
    }
  }
  return questions.map((question) => ({ ...question, question: question.question.trim(), options: question.options.map((option) => option.trim()) }));
}

/** An AskUser call's input, in either of the shapes Droid has used: a questionnaire, or a list of questions. */
export function inputQuestions(args: Record<string, unknown>): AskedQuestion[] {
  if (typeof args.questionnaire === 'string') return parseQuestionnaire(args.questionnaire);
  if (!Array.isArray(args.questions)) return [];
  return args.questions.flatMap((value: unknown) => {
    if (!value || typeof value !== 'object') return [];
    const q = value as Record<string, unknown>;
    if (typeof q.question !== 'string' || !Array.isArray(q.options)) return [];
    const options = q.options.flatMap((option: unknown) => {
      const label = typeof option === 'string' ? option : option && typeof option === 'object' ? (option as Record<string, unknown>).label : undefined;
      return typeof label === 'string' && label.trim() ? [label.trim()] : [];
    });
    const topic = typeof q.header === 'string' ? q.header.trim() : typeof q.topic === 'string' ? q.topic.trim() : '';
    return [{ question: q.question.trim(), ...(topic ? { topic } : {}), options, multiSelect: q.multiSelect === true || q.multi_select === true }];
  });
}

/** Full question text comes from the pending tool call, never the terminal's viewport. */
export function askedQuestions(entries: readonly ThreadEntry[]): AskedQuestion[] {
  const call = [...entries].reverse().find((entry) => entry.kind === 'tool' && ['askuser', 'askuserquestion', 'request_user_input'].includes(entry.name?.split(/[.:/]/).at(-1)?.toLowerCase() ?? ''));
  if (!call || call.output !== undefined) return [];
  try {
    return inputQuestions(JSON.parse(call.input ?? '{}'));
  } catch {
    return [];
  }
}

/** What a permission prompt asks, in one line: "Approve high-risk command: rm -rf build". */
export function permissionLine(ask: Extract<WorkerAsk, { kind: 'permission' }>): string {
  const risk = ask.risk && /^(low|medium|high)$/.test(ask.risk) ? `${ask.risk}-risk ` : '';
  const what = ask.tool === 'Execute' ? 'command' : ask.tool;
  const detail = ask.command ?? ask.file ?? ask.summary;
  return `Approve ${risk}${what}${detail ? `: ${detail}` : ''}`;
}

/** The whole questionnaire being asked: the hook's pending ask (exact text), else the Thread's pending call. */
export function pendingQuestions(entries: readonly ThreadEntry[], ask?: WorkerAsk): AskedQuestion[] {
  return ask?.kind === 'question' && ask.questions.length ? ask.questions : askedQuestions(entries);
}

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.…]+$/, '');

export interface QuestionDisplay {
  question: string;
  choices: Menu['choices'];
  /** Which question of a questionnaire this is, when the menu matched one. */
  position?: number;
  total?: number;
  /** The text is the ask's own, not pieced together from the screen. */
  complete: boolean;
}

/**
 * The card for the menu on screen. The hook's pending ask (WorkerInfo.ask) has the exact text; the
 * Thread's pending tool call is the fallback for an office that doesn't send one. Every numbered
 * option is matched in order: ambiguous or mismatching questions cannot relabel an answer.
 */
export function questionPresentation(menu: Menu, entries: readonly ThreadEntry[], ask?: WorkerAsk): QuestionDisplay {
  if (menu.review) return { question: 'Review your answers', choices: menu.choices, complete: true };
  if (ask?.kind === 'permission') return { question: permissionLine(ask), choices: menu.choices, complete: true };
  const all = pendingQuestions(entries, ask);
  const matches = all.filter(
    (q) =>
      q.options.length === menu.choices.length &&
      q.multiSelect === !!menu.multiSelect &&
      menu.choices.every((choice, index) => {
        const label = normalize(choice.label);
        return label.length > 0 && normalize(q.options[index]).startsWith(label);
      }),
  );
  const byQuestion = matches.filter((question) => menu.question && normalize(question.question).endsWith(normalize(menu.question)));
  const full = matches.length === 1 ? matches[0] : byQuestion.length === 1 ? byQuestion[0] : undefined;
  return {
    question: full?.question || menu.question || 'Choose an answer',
    choices: menu.choices.map((choice, index) => ({ ...choice, ...(full ? { label: full.options[index], description: undefined } : {}) })),
    ...(full ? { position: all.indexOf(full) + 1, total: all.length } : {}),
    complete: !!full,
  };
}

/** AskUser's review summary as question and answer pairs: each `→` line answers the lines above it. */
export function reviewAnswers(review: readonly string[]): { question: string; answer: string }[] {
  const pairs: { question: string; answer: string }[] = [];
  let question: string[] = [];
  for (const raw of review) {
    const line = raw.trim();
    const answer = /^→\s*(.*)$/.exec(line);
    if (answer && !question.length && pairs.length) pairs[pairs.length - 1]!.answer += `, ${answer[1]!.trim()}`;
    else if (answer) {
      pairs.push({ question: question.join(' '), answer: answer[1]!.trim() });
      question = [];
    } else if (line) question.push(line);
  }
  if (question.length) pairs.push({ question: question.join(' '), answer: '' });
  return pairs;
}

export type QuestionStepState = 'done' | 'current' | 'upcoming';
export interface QuestionStep {
  /** The question's topic (AskUser's tab name), else the start of the question. */
  label: string;
  state: QuestionStepState;
  /** The answer a done step was given: the review's own summary, else what this client sent. */
  answer?: string;
  /** Droid's final "Review your answers" step, which follows every multi-question questionnaire. */
  review?: true;
}

const STEP_LABEL = 28;
function stepLabel(question: AskedQuestion): string {
  if (question.topic?.trim()) return question.topic.trim();
  const first = question.question.split('\n')[0]!.trim();
  if (first.length <= STEP_LABEL) return first;
  const cut = first.slice(0, STEP_LABEL - 1);
  return `${cut.replace(/\s+\S*$/, '') || cut}…`;
}

/**
 * Where the menu on screen sits in its questionnaire, for a step bar: one step per question and a
 * final review. Empty for a lone question, or when the menu matches no single question.
 * `answers` holds what this client sent, by 1-based position.
 */
export function questionSteps(menu: Menu, display: QuestionDisplay, all: readonly AskedQuestion[], answers: Readonly<Record<number, string>> = {}): QuestionStep[] {
  if (!all.length || (all.length < 2 && !menu.review) || (!menu.review && !display.position)) return [];
  const reviewed = menu.review ? reviewAnswers(menu.review) : [];
  const at = menu.review ? all.length + 1 : display.position!;
  const steps: QuestionStep[] = all.map((question, index) => {
    const state: QuestionStepState = index + 1 < at ? 'done' : index + 1 === at ? 'current' : 'upcoming';
    const answer = state === 'done' ? (reviewed.length === all.length ? reviewed[index]!.answer : '') || answers[index + 1] : undefined;
    return { label: stepLabel(question), state, ...(answer ? { answer } : {}) };
  });
  steps.push({ label: 'Review', state: menu.review ? 'current' : 'upcoming', review: true });
  return steps;
}

/** One line for what a reply answered, in the question's own words: "UTM", or "Roster, Inbox + Keep shortcuts". */
export function replySummary(display: QuestionDisplay, reply: { choice?: number; choices?: number[]; text?: string }): string {
  const label = (number: number) => {
    const choice = display.choices.find((c) => c.number === number);
    return choice ? choice.label.split('\n')[0]!.trim() : String(number);
  };
  const text = reply.text?.replace(/\s+/g, ' ').trim();
  if (reply.choices) return [reply.choices.map(label).join(', '), text].filter(Boolean).join(' + ');
  if (text) return text;
  return reply.choice !== undefined ? label(reply.choice) : '';
}
