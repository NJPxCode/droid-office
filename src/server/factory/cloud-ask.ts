import type { Menu } from '../../shared/asks.js';
import { sameMenu } from '../../shared/asks.js';
import type { AskedQuestion } from '../../shared/protocol.js';
import { record } from './cloud-stream-messages.js';

// A cloud worker's AskUser, held from its computer's relay (daemon.ask_user) until the owner answers
// it. The office shows one question at a time as a menu, like a terminal's, and sends every answer
// together once the last one is in: the session sees only the finished questionnaire.

const TEXT_MAX = 4000;
const OPTION_MAX = 500;
const MAX_QUESTIONS = 20;
const MAX_OPTIONS = 20;
export const ANSWER_MAX = 20_000;

export interface CloudAskQuestion {
  /** Droid's own 1-based index, sent back with the answer. */
  index: number;
  topic?: string;
  question: string;
  options: string[];
  descriptions?: (string | undefined)[];
  multiSelect: boolean;
}

export interface CloudAsk {
  requestId: string;
  toolCallId: string;
  questions: CloudAskQuestion[];
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** An AskUser request's params (`toolCallId`, `questions`) with its id, or undefined when it isn't one the office can show. */
export function cloudAsk(requestId: unknown, params: unknown): CloudAsk | undefined {
  const p = record(params);
  if (typeof requestId !== 'string' || !requestId || !Array.isArray(p.questions)) return undefined;
  const questions: CloudAskQuestion[] = [];
  for (const raw of p.questions.slice(0, MAX_QUESTIONS)) {
    const q = record(raw);
    const question = text(q.question, TEXT_MAX);
    const options = Array.isArray(q.options) ? q.options.slice(0, MAX_OPTIONS).map((o) => text(o, OPTION_MAX)) : [];
    if (!question || options.some((o) => !o)) return undefined;
    const described = Array.isArray(q.optionDescriptions) ? options.map((_, i) => text((q.optionDescriptions as unknown[])[i], TEXT_MAX) || undefined) : undefined;
    questions.push({
      index: Number.isInteger(q.index) ? (q.index as number) : questions.length + 1,
      ...(text(q.topic, OPTION_MAX) ? { topic: text(q.topic, OPTION_MAX) } : {}),
      question,
      options,
      ...(described?.some(Boolean) ? { descriptions: described } : {}),
      multiSelect: q.multiSelect === true,
    });
  }
  if (!questions.length) return undefined;
  return { requestId, toolCallId: typeof p.toolCallId === 'string' ? p.toolCallId : '', questions };
}

/** The questionnaire as a worker's `ask` carries it. */
export function askedQuestions(ask: CloudAsk): AskedQuestion[] {
  return ask.questions.map((q) => ({ question: q.question, ...(q.topic ? { topic: q.topic } : {}), options: q.options, multiSelect: q.multiSelect }));
}

/** One question as the menu the companions answer, with a typed answer always allowed, as Droid's own AskUser does. */
export function askMenu(q: CloudAskQuestion): Menu {
  return {
    question: q.question,
    choices: q.options.map((label, i) => ({ number: i + 1, label, ...(q.descriptions?.[i] ? { description: q.descriptions[i] } : {}) })),
    freeText: true,
    ...(q.multiSelect ? { multiSelect: true } : {}),
  };
}

export type AskReply = { choice?: number; choices?: number[]; text?: string };

/** The answer `reply` gives the question `current` shows, or why it can't be sent. */
export function askAnswer(current: Menu | undefined, shown: Menu, reply: AskReply): { answer: string } | { error: string } {
  if (!current || !sameMenu(shown, current)) return { error: 'The question changed or was already answered. Your answer was not sent.' };
  const typed = reply.text?.trim().slice(0, ANSWER_MAX);
  if (reply.text !== undefined && !typed && !reply.choices?.length) return { error: 'Write an answer, or pick one.' };
  const label = (n: number) => current.choices.find((c) => c.number === n)?.label;
  if (current.multiSelect) {
    if (reply.choice !== undefined) return { error: 'Select the answers, then submit them together.' };
    const numbers = reply.choices ?? [];
    if (new Set(numbers).size !== numbers.length || numbers.some((n) => !Number.isInteger(n) || !label(n))) return { error: 'Those choices are no longer available.' };
    const picked = current.choices.filter((c) => numbers.includes(c.number)).map((c) => c.label);
    if (typed) picked.push(typed);
    if (!picked.length) return { error: 'Select at least one answer.' };
    return { answer: picked.join(', ') };
  }
  if (reply.choices !== undefined) return { error: 'Pick one answer.' };
  if (typed) return { answer: typed };
  const picked = reply.choice !== undefined ? label(reply.choice) : undefined;
  return picked ? { answer: picked } : { error: 'That choice is no longer available.' };
}
