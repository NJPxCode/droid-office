import { h } from './dom';
import { mdIcon, wireIconCopy } from './thread-md-icons';

// Factory's email draft block: a ```email fence becomes an editable draft with Copy email, Send
// (mail app, Gmail or Outlook compose) and Revert once edited.

export interface EmailDraft {
  to: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  subject?: string;
  body: string;
  raw: string;
}

const KNOWN_EMAIL_HEADERS = new Set(['to', 'cc', 'bcc', 'in-reply-to', 'subject', 'from', 'reply-to']);

/** Parses an `email` fenced code block with RFC-style headers before the blank line + body. */
export function parseEmailDraft(raw: string): EmailDraft | null {
  const normalized = raw.replace(/\r\n/g, '\n');
  const trimmedStart = normalized.replace(/^\n+/, '');
  if (!trimmedStart.trim()) return null;

  const blankIdx = trimmedStart.indexOf('\n\n');
  const headerPart = blankIdx === -1 ? trimmedStart : trimmedStart.slice(0, blankIdx);
  const bodyPart = blankIdx === -1 ? '' : trimmedStart.slice(blankIdx + 2);

  const lines = headerPart.split('\n');
  const headers = new Map<string, string>();
  let lastHeaderKey = '';

  for (const line of lines) {
    if (/^[ \t]+\S/.test(line) && lastHeaderKey) {
      headers.set(lastHeaderKey, `${headers.get(lastHeaderKey) ?? ''} ${line.trim()}`.trim());
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!KNOWN_EMAIL_HEADERS.has(key)) return null;
    const val = line.slice(colon + 1).trim();
    const prev = headers.get(key);
    headers.set(key, prev ? `${prev}, ${val}` : val);
    lastHeaderKey = key;
  }

  const to = headers.get('to') ?? '';
  const subject = headers.get('subject');
  if (!to && !subject) return null;

  const draft: EmailDraft = {
    to,
    body: bodyPart.replace(/\n+$/, ''),
    raw: trimmedStart.replace(/\n+$/, ''),
  };
  const cc = headers.get('cc');
  const bcc = headers.get('bcc');
  const inReplyTo = headers.get('in-reply-to');
  if (cc) draft.cc = cc;
  if (bcc) draft.bcc = bcc;
  if (inReplyTo) draft.inReplyTo = inReplyTo;
  if (subject !== undefined && subject !== '') draft.subject = subject;
  return draft;
}

function extractRecipientAddresses(rawRecipients: string): string {
  return rawRecipients
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return '';
      const angle = /<([^<>@\s]+@[^<>@\s]+)>/.exec(trimmed);
      const addr = angle ? angle[1] : trimmed;
      return encodeURIComponent(addr).replace(/%40/g, '@');
    })
    .filter(Boolean)
    .join(',');
}

/** Builds a `mailto:` URL using `encodeURIComponent` (spaces encoded as `%20`, never `+`). */
export function buildMailtoHref(draft: EmailDraft): string {
  const toPath = draft.to ? extractRecipientAddresses(draft.to) : '';
  const params: string[] = [];
  if (draft.cc) params.push(`cc=${encodeURIComponent(draft.cc)}`);
  if (draft.bcc) params.push(`bcc=${encodeURIComponent(draft.bcc)}`);
  if (draft.inReplyTo) params.push(`in-reply-to=${encodeURIComponent(draft.inReplyTo)}`);
  if (draft.subject) params.push(`subject=${encodeURIComponent(draft.subject)}`);
  if (draft.body) params.push(`body=${encodeURIComponent(draft.body)}`);
  return params.length ? `mailto:${toPath}?${params.join('&')}` : `mailto:${toPath}`;
}

export type EmailTarget = 'mail' | 'gmail' | 'outlook';

/** The compose URL for `draft` in the mail app, Gmail on the web, or Outlook on the web. */
export function emailComposeHref(draft: EmailDraft, target: EmailTarget): string {
  if (target === 'mail') return buildMailtoHref(draft);
  const q = new URLSearchParams();
  const add = (k: string, v: string | undefined) => {
    if (v) q.set(k, v);
  };
  if (target === 'gmail') {
    q.set('view', 'cm');
    q.set('fs', '1');
    add('to', draft.to);
    add('cc', draft.cc);
    add('bcc', draft.bcc);
    add('su', draft.subject);
    add('body', draft.body);
    return `https://mail.google.com/mail/?${q.toString().replace(/\+/g, '%20')}`;
  }
  add('to', draft.to);
  add('cc', draft.cc);
  add('bcc', draft.bcc);
  add('subject', draft.subject);
  add('body', draft.body);
  return `https://outlook.office.com/mail/deeplink/compose?${q.toString().replace(/\+/g, '%20')}`;
}

/** The draft as plain text, headers then body, for "Copy email". */
export function emailAsText(draft: EmailDraft): string {
  const head = [
    ['To', draft.to],
    ['Cc', draft.cc],
    ['Bcc', draft.bcc],
    ['Subject', draft.subject],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`);
  return draft.body ? `${head.join('\n')}\n\n${draft.body}` : head.join('\n');
}

const TARGETS: { id: EmailTarget; label: string; description: string }[] = [
  { id: 'mail', label: 'Mail app', description: "Your computer's email app" },
  { id: 'gmail', label: 'Gmail', description: 'Compose in Gmail on the web' },
  { id: 'outlook', label: 'Outlook', description: 'Compose in Outlook on the web' },
];

/** The editable Factory email draft card for `draft`. `streaming` holds Send until the draft finishes. */
export function renderEmailDraft(draft: EmailDraft, opts: { streaming?: boolean } = {}): HTMLElement {
  const original = { ...draft };
  const title = h('span.wt-md-email-title', {}, 'Email draft');

  const field = (label: string, value: string | undefined, placeholder: string) => {
    const input = h('input.wt-md-email-input', { type: 'text', value: value ?? '', placeholder, 'aria-label': label, spellcheck: 'false' });
    input.value = value ?? '';
    const row = h('label.wt-md-email-row', {}, h('span.wt-md-email-label', {}, label), input);
    return { input, row };
  };
  const to = field('To', draft.to, 'Add recipients');
  const cc = field('Cc', draft.cc, 'Add recipients');
  const bcc = field('Bcc', draft.bcc, 'Add recipients');
  const subject = field('Subject', draft.subject, 'Add a subject');
  const showCopies = Boolean(draft.cc || draft.bcc);
  cc.row.hidden = !showCopies;
  bcc.row.hidden = !showCopies;
  const ccToggle = h('button.wt-md-email-cc', { type: 'button', hidden: showCopies }, 'Cc/Bcc');
  ccToggle.addEventListener('click', (e) => {
    e.preventDefault();
    cc.row.hidden = false;
    bcc.row.hidden = false;
    ccToggle.hidden = true;
    cc.input.focus();
  });
  to.row.append(ccToggle);

  const body = h('textarea.wt-md-email-body', { 'aria-label': 'Message', placeholder: 'Write your message', rows: 3, spellcheck: 'true' });
  body.value = draft.body;

  const current = (): EmailDraft => {
    const d: EmailDraft = { to: to.input.value.trim(), body: body.value, raw: '' };
    if (cc.input.value.trim()) d.cc = cc.input.value.trim();
    if (bcc.input.value.trim()) d.bcc = bcc.input.value.trim();
    if (subject.input.value.trim()) d.subject = subject.input.value.trim();
    if (original.inReplyTo) d.inReplyTo = original.inReplyTo;
    return d;
  };

  const copy = h('button.wt-md-email-btn', { type: 'button' });
  wireIconCopy(copy, () => emailAsText(current()), { idle: 'Copy email', done: 'Copied' }, { size: 14 });

  const revert = h('button.wt-md-email-btn.wt-md-email-revert', { type: 'button', hidden: true, title: 'Discard your edits and restore the original draft' }, 'Revert');
  const send = h(
    'button.wt-md-email-send',
    { type: 'button', disabled: opts.streaming, title: opts.streaming ? 'Available when the draft finishes' : "Open a filled-in draft in your computer's mail app" },
    mdIcon('send', 12),
    h('span', {}, 'Send'),
  );
  const more = h('button.wt-md-email-send-more', { type: 'button', disabled: opts.streaming, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'More ways to send', title: 'More ways to send' }, mdIcon('chevronDown', 12));
  const menu = h(
    'div.wt-md-email-menu',
    { role: 'menu', hidden: true },
    ...TARGETS.map((t) => {
      const item = h('button.wt-md-email-item', { type: 'button', role: 'menuitem' }, h('span.wt-md-email-item-label', {}, t.label), h('span.wt-md-email-item-desc', {}, t.description));
      item.addEventListener('click', () => {
        menu.hidden = true;
        more.setAttribute('aria-expanded', 'false');
        openCompose(t.id);
      });
      return item;
    }),
  );
  const openCompose = (target: EmailTarget) => {
    const href = emailComposeHref(current(), target);
    if (target === 'mail') location.href = href;
    else window.open(href, '_blank', 'noopener,noreferrer');
  };
  send.addEventListener('click', () => openCompose('mail'));
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    more.setAttribute('aria-expanded', String(!menu.hidden));
  });
  const split = h('div.wt-md-email-split', {}, send, more, menu);

  const sync = () => {
    const now = current();
    const edited = now.to !== original.to || (now.cc ?? '') !== (original.cc ?? '') || (now.bcc ?? '') !== (original.bcc ?? '') || (now.subject ?? '') !== (original.subject ?? '') || now.body !== original.body;
    title.textContent = edited ? 'Email draft · Edited' : 'Email draft';
    revert.hidden = !edited;
  };
  for (const el of [to.input, cc.input, bcc.input, subject.input, body]) el.addEventListener('input', sync);
  revert.addEventListener('click', () => {
    to.input.value = original.to;
    cc.input.value = original.cc ?? '';
    bcc.input.value = original.bcc ?? '';
    subject.input.value = original.subject ?? '';
    body.value = original.body;
    sync();
  });

  const card = h(
    'div.wt-md-email',
    { 'data-testid': 'email-draft' },
    h('div.wt-md-email-head', {}, title, h('div.wt-md-email-actions', {}, revert, copy, split)),
    to.row,
    cc.row,
    bcc.row,
    subject.row,
    h('div.wt-md-email-message', {}, body),
  );
  card.addEventListener('focusout', (e) => {
    if (!split.contains(e.relatedTarget as Node)) {
      menu.hidden = true;
      more.setAttribute('aria-expanded', 'false');
    }
  });
  return card;
}
