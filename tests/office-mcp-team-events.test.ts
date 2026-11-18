import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createOfficeMcp, OFFICE_MCP_PATH, OFFICE_MCP_WORKER_HEADER, type OfficeMcpFloor } from '../src/server/office-mcp/index.js';
import type { OwnerOffice } from '../src/server/office-mcp/owner.js';
import { parseCursor } from '../src/server/office-mcp/team-events.js';
import { RemoteOffice, type RemoteFloor } from '../src/server/remote-office.js';
import { RemoteWorkers } from '../src/server/remote-workers.js';
import { Team, type TeamWorkers } from '../src/server/team.js';
import { Visits } from '../src/server/visits.js';
import { WhiteboardStore } from '../src/server/whiteboard.js';
import type { Menu } from '../src/shared/asks.js';
import { SUBAGENT_DEFAULTS, type SubagentSettings, type WorkerInfo } from '../src/shared/protocol.js';

const FILE_MENU: Menu = {
  question: 'Which file should I create?',
  choices: [
    { number: 1, label: 'hello.txt', description: 'A greeting' },
    { number: 2, label: 'bye.txt' },
    { number: 3, label: 'Other (type your answer)' },
  ],
  freeText: true,
};
const LONG_REPORT = ['Done: fixed the redirect.', ...Array.from({ length: 60 }, (_, i) => `| bench ${i} | ${i * 3} ms | ok |`)].join('\n');

function worker(id: string, extra: Partial<WorkerInfo> = {}): WorkerInfo {
  return { id, name: id, kind: 'agent', deskId: 'desk-1', color: '#fff', status: 'done', acked: true, createdBy: 'test', createdAt: 1, cols: 100, rows: 30, open: false, ...extra };
}

async function rig(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-mcp-events-'));
  const settings: SubagentSettings = { ...SUBAGENT_DEFAULTS, wakeLead: false };
  const people = new Map([['lead', worker('lead', { name: 'Nibble' })]]);
  const answered: { id: string; reply: { menu?: Menu; choice?: number; choices?: number[]; text?: string } }[] = [];
  const ownerActions: Record<string, unknown>[] = [];
  let answerGate: Promise<void> | undefined;
  const prompts: [string, string][] = [];
  let hired = 0;
  let now = Date.parse('2026-11-03T12:00:00Z');
  const workers: TeamWorkers & OfficeMcpFloor['workers'] & RemoteFloor['workers'] = {
    list: () => [...people.values()],
    get: (id) => people.get(id),
    authenticate: (id, token) => (token === `token-${id}` ? people.get(id) : undefined),
    releaseLead: () => {},
    officeDefault: undefined,
    deskOccupied: (desk) => [...people.values()].some((w) => w.deskId === desk),
    hire: (deskId, _by, _prompt, worktree, _choice, lead) => {
      const id = `sub${++hired}`;
      const sub = worker(id, {
        name: ['Pixel', 'Byte'][hired - 1] ?? id,
        deskId,
        lead,
        status: 'working',
        createdAt: hired + 1,
        ...(worktree ? { worktree: { path: `.droid-office/worktrees/${id}`, branch: `office/${id}`, base: 'abc' } } : {}),
      });
      people.set(id, sub);
      return sub;
    },
    prompt: (id, message) => {
      prompts.push([id, message]);
      return undefined;
    },
    resume: () => undefined,
    kill: async (id) => {
      people.delete(id);
      team.onWorkerGone(id);
      return {};
    },
    tail: () => '',
    setTask: (id, task) => {
      const w = people.get(id);
      if (w) w.task = task;
    },
    answerQuestion: async (id, reply) => {
      answered.push({ id, reply });
      if (answerGate) await answerGate;
      return {};
    },
  };
  const team = new Team(workers, { dataDir: dir, dir, git: true, settings: () => settings, toast() {}, now: () => now });
  const visits = new Visits({ ...workers, cancelTurn: () => false }, { on: () => settings.visits, emit() {} });
  const whiteboard = new WhiteboardStore(dir);
  const floor: OfficeMcpFloor & RemoteFloor = { id: 'floor', name: 'Floor', def: { name: 'Floor' }, dir, workers, team, visits, whiteboard };
  const remoteStore = new RemoteWorkers(dir);
  const remote = new RemoteOffice(remoteStore, () => [floor]);
  const owner: OwnerOffice = {
    floors: () => [{ id: 'floor', name: 'Floor', workers: [...people.values()] }],
    mission: () => [],
    tail: () => '',
    act: async (_by, msg) => {
      ownerActions.push(msg);
      return { notes: [] };
    },
  };
  const office = createOfficeMcp({
    settings: () => settings,
    floor: (id) => (people.has(id) ? floor : undefined),
    remote,
    owner,
    orchestrator: {
      cwd: dir,
      authenticate: (id, token) => (id === 'orchestrator' && token === 'token-orchestrator' ? worker('orchestrator', { name: 'Orchestrator', deskId: '' }) : undefined),
    },
  });
  const http = createServer((req, res) => {
    if (req.url === OFFICE_MCP_PATH) void office.handle(req, res);
    else res.writeHead(404).end();
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}${OFFICE_MCP_PATH}`);
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map((c) => c.close()));
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    team.stop();
    visits.stop();
    whiteboard.stop();
    remote.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  async function connect(id: string) {
    const client = new Client({ name: 'events-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { [OFFICE_MCP_WORKER_HEADER]: id, Authorization: `Bearer token-${id}` } } }));
    return client;
  }
  const lead = await connect('lead');
  async function call(client: Client, name: string, args: Record<string, unknown> = {}, options?: Parameters<Client['callTool']>[1]) {
    const result = await client.callTool({ name, arguments: args }, options);
    const text = (result.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');
    return { ...result, text, body: result.structuredContent as Record<string, any> };
  }
  const hire = (title = 'Fix login') => call(lead, 'team_hire', { title, brief: 'Fix the redirect, test, commit and report.' });
  const status = (args: Record<string, unknown> = {}) => call(lead, 'team', { action: 'status', ...args });
  function set(id: string, status: WorkerInfo['status'], extra: Partial<WorkerInfo> = {}) {
    const w = people.get(id)!;
    Object.assign(w, extra, { status });
    team.onWorker({ ...w });
  }
  /** Resolves once `n` waits are listening, however slow the machine is. */
  async function held(n: number) {
    for (let i = 0; i < 500 && team.watchers() !== n; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(team.watchers(), n);
  }
  return {
    dir,
    url,
    settings,
    people,
    answered,
    ownerActions,
    setAnswerGate: (gate: Promise<void> | undefined) => {
      answerGate = gate;
    },
    prompts,
    team,
    connect,
    call,
    lead,
    hire,
    status,
    set,
    held,
    tick: (ms: number) => (now += ms),
  };
}

test('status keeps its prose and adds compact workers, typed news with ids and times, and a cursor', async (t) => {
  const r = await rig(t);
  await r.hire();
  const sub = await r.connect('sub1');
  r.set('sub1', 'working', { activity: 'Running tests' });
  await r.call(sub, 'team_report', { text: LONG_REPORT });
  const legacy = await r.status();
  assert.match(legacy.text, /Last report:\nDone: fixed the redirect\.\n\| bench 0/, 'the full prose stays for existing callers');
  assert.match(legacy.text, /News since your last status call:\n(\[[^\]]+\] )?Worker report from Pixel/);
  assert.equal(legacy.body.team[0].report.text, LONG_REPORT, 'the old structured fields are still there');
  const [pixel] = legacy.body.workers;
  assert.equal(pixel.id, 'sub1');
  assert.equal(pixel.state, 'working');
  assert.equal(pixel.doing, 'Running tests');
  assert.equal(pixel.task, 'Fix login');
  assert.equal(pixel.branch, 'office/sub1');
  assert.equal(pixel.worktree, path.join(r.dir, '.droid-office/worktrees/sub1'));
  assert.equal(pixel.lastReportId, 'team:floor:1');
  assert.equal(pixel.lastReportAt, '2026-11-03T12:00:00.000Z');
  assert.ok(pixel.lastReportSummary.length <= 240 && pixel.lastReportSummary.startsWith('Done: fixed the redirect.'));
  assert.deepEqual(legacy.body.news[0], {
    id: 'team:floor:1',
    kind: 'report',
    worker: 'sub1',
    name: 'Pixel',
    floor: 'floor',
    at: '2026-11-03T12:00:00.000Z',
    summary: pixel.lastReportSummary,
    result: { status: 'ok', summary: pixel.lastReportSummary },
  });
  assert.equal(legacy.body.cursor, 'team:floor:1');

  r.tick(1000);
  await r.call(sub, 'team_report', { text: LONG_REPORT });
  const compact = await r.status({ verbose: false });
  assert.ok(compact.text.length < 900, `compact status stays short (${compact.text.length} chars)`);
  assert.doesNotMatch(compact.text, /bench 59/);
  assert.match(compact.text, /^Pixel \(sub1\) working, Desk \d+: Fix login\./);
  assert.match(compact.text, /\[team:floor:2 2026-11-03T12:00:01\.000Z\] report Pixel: Done/);
  assert.match(compact.text, /Cursor: team:floor:2$/);
  assert.equal(compact.body.team, undefined, 'compact structured content drops the whole reports');
  assert.equal(compact.body.news[0].text, undefined);
  assert.equal((await r.status({ name: 'pixel', verbose: false })).body.workers.length, 1, 'name filters the structured workers too');

  const full = await r.call(r.lead, 'team_report_get', { worker: 'Pixel' });
  assert.equal(full.isError, undefined);
  assert.equal(full.body.report.text, LONG_REPORT);
  assert.equal(full.body.report.id, 'team:floor:2');
  assert.deepEqual(
    full.body.history.map((e: { id: string }) => e.id),
    ['team:floor:1', 'team:floor:2'],
  );
  assert.equal((await r.call(r.lead, 'team_report_get', { id: 'team:floor:1' })).body.report.id, 'team:floor:1');
  assert.equal((await r.call(r.lead, 'team_report_get', { id: 'team:floor:99' })).isError, true);
  assert.equal((await r.call(r.lead, 'team_report_get', { id: 'team:floor:1,team:floor:2' })).isError, true, 'a cursor is not one id');
  assert.equal((await r.call(r.lead, 'team_report_get', {})).isError, true);
  await r.call(r.lead, 'team', { action: 'dismiss', name: 'Pixel' });
  assert.equal((await r.call(r.lead, 'team_report_get', { worker: 'Pixel' })).body.report.text, LONG_REPORT, 'reports outlive the subagent');

  for (const args of [
    { action: 'message', name: 'Pixel', text: 'hi', verbose: false },
    { action: 'dismiss', name: 'Pixel', since: '1' },
    { action: 'status', since: 'yesterday' },
  ])
    assert.equal((await r.call(r.lead, 'team', args)).isError, true, JSON.stringify(args));
});

test('team_report_get by a name reused after a dismissal reads the subagent on the team now', async (t) => {
  const r = await rig(t);
  await r.hire();
  await r.call(await r.connect('sub1'), 'team_report', { text: 'First Pixel: 235 lines.' });
  assert.equal((await r.call(r.lead, 'team', { action: 'dismiss', name: 'sub1' })).isError, undefined);
  await r.hire();
  r.people.get('sub2')!.name = 'Pixel';
  await r.call(await r.connect('sub2'), 'team_report', { text: 'Second Pixel: 234 lines.' });
  const now = await r.call(r.lead, 'team_report_get', { worker: 'Pixel' });
  assert.equal(now.isError, undefined, now.text);
  assert.equal(now.body.report.text, 'Second Pixel: 234 lines.');
  assert.equal(now.body.report.worker, 'sub2');
  assert.equal((await r.call(r.lead, 'team_report_get', { worker: 'sub1' })).body.report.text, 'First Pixel: 235 lines.', 'the id still reads the former one');

  assert.equal((await r.call(r.lead, 'team', { action: 'dismiss', name: 'sub2' })).isError, undefined);
  const gone = await r.call(r.lead, 'team_report_get', { worker: 'Pixel' });
  assert.equal(gone.isError, true, 'two former subagents by one name stay ambiguous');
  assert.match(gone.text, /Pixel names more than one subagent: use the worker id/);
  assert.doesNotMatch(gone.text, /several floors/, 'they are on one floor');
});

test('team_status returns the same structured workers, news and cursor, with verbose, since and kinds', async (t) => {
  const r = await rig(t);
  await r.hire();
  const pixel = await r.connect('sub1');
  await r.call(pixel, 'team_report', { text: LONG_REPORT });
  const full = await r.call(r.lead, 'team_status');
  assert.match(full.text, /Last report:\nDone: fixed the redirect\./);
  assert.equal(full.body.workers[0].lastReportId, 'team:floor:1');
  assert.equal(full.body.news[0].id, 'team:floor:1');
  assert.equal(full.body.cursor, 'team:floor:1');
  await r.call(pixel, 'team_report', { text: 'Which branch?', question: true });
  const compact = await r.call(r.lead, 'team_status', { worker: 'Pixel', verbose: false, kinds: ['question'] });
  assert.match(compact.text, /^Pixel \(sub1\) blocked_on_question/);
  assert.equal(compact.body.team, undefined);
  assert.deepEqual(
    compact.body.news.map((e: { id: string }) => e.id),
    ['team:floor:2'],
  );
  const replay = await r.call(r.lead, 'team_status', { since: 'team:floor:0', verbose: false });
  assert.deepEqual(
    replay.body.news.map((e: { id: string }) => e.id),
    ['team:floor:1', 'team:floor:2'],
  );
  assert.equal((await r.call(r.lead, 'team_status', { since: 'yesterday' })).isError, true);
  assert.equal((await r.call(r.lead, 'team_status', { kinds: ['soon'] })).isError, true);
});

test('since reads news after a cursor without draining what else is unread, and kinds filter by type', async (t) => {
  const r = await rig(t);
  await r.hire();
  await r.hire();
  const pixel = await r.connect('sub1');
  await r.call(pixel, 'team_report', { text: 'First' });
  const cursor = (await r.status({ verbose: false })).body.cursor;
  r.set('sub2', 'needs_input', { activity: 'Allow rm?' });
  await r.call(pixel, 'team_report', { text: 'Which branch?', question: true });
  const blocked = await r.status({ kinds: ['blocked'], verbose: false });
  assert.deepEqual(
    blocked.body.news.map((e: { kind: string }) => e.kind),
    ['needs_input'],
  );
  const after = await r.status({ since: cursor, verbose: false });
  assert.deepEqual(
    after.body.news.map((e: { kind: string; id: string }) => `${e.kind} ${e.id}`),
    ['needs_input team:floor:2', 'question team:floor:3'],
    'since includes news already heard',
  );
  assert.deepEqual((await r.status({ verbose: false })).body.news, [], 'the since read drained what it showed');
  assert.deepEqual((await r.status({ since: after.body.cursor })).body.news, []);
  assert.equal((await r.status({ since: '2' })).body.news.length, 1, 'a bare seq is on the caller’s floor');
  assert.deepEqual(
    [...parseCursor('team:a:3,team:b-2:7,team:a:1', 'own')!],
    [
      ['a', 3],
      ['b-2', 7],
    ],
  );
  assert.equal(parseCursor('team:a:x', 'own'), undefined);
});

test('a question makes the subagent blocked_on_question until its lead answers through question_answer', async (t) => {
  const r = await rig(t);
  await r.hire();
  const pixel = await r.connect('sub1');
  assert.match((await r.call(pixel, 'team_report', { text: 'Pick one', options: ['A', 'B'] })).text, /only for a question/, 'a report never drops options silently');
  await r.call(pixel, 'team_report', { text: 'Which database?', question: true, options: ['Postgres', 'SQLite'] });
  r.set('sub1', 'done');
  const listed = await r.call(r.lead, 'questions_list');
  assert.equal(listed.body.questions.length, 1);
  const [asked] = listed.body.questions;
  assert.equal(asked.id, 'team:floor:1');
  assert.equal((await r.call(r.lead, 'question_answer', { questionId: 'team:floor:0,team:floor:1', optionId: '1' })).isError, true, 'a cursor is not one question id');
  assert.equal(asked.kind, 'team');
  assert.deepEqual(asked.options, [
    { id: '1', label: 'Postgres' },
    { id: '2', label: 'SQLite' },
  ]);
  assert.equal((await r.status()).body.workers[0].state, 'blocked_on_question');
  assert.equal((await r.status()).body.workers[0].openQuestionId, 'team:floor:1');
  assert.equal((await r.call(r.lead, 'question_answer', { questionId: asked.id, optionId: '3' })).isError, true);
  assert.equal((await r.call(r.lead, 'question_answer', { questionId: asked.id })).isError, true);
  const answered = await r.call(r.lead, 'question_answer', { questionId: asked.id, optionId: '2', text: 'Keep it local.' });
  assert.equal(answered.isError, undefined);
  assert.deepEqual(answered.body, { answered: true, questionId: 'team:floor:1', worker: 'sub1' });
  assert.match(r.prompts.at(-1)![1], /SQLite\n\nKeep it local\./);
  assert.deepEqual((await r.call(r.lead, 'questions_list')).body.questions, []);
  assert.equal((await r.status()).body.workers[0].state, 'done');
  assert.equal((await r.call(r.lead, 'question_answer', { questionId: asked.id, text: 'again' })).isError, true, 'answered once');

  await r.call(pixel, 'team_report', { text: 'Another?', question: true });
  r.set('sub1', 'working');
  assert.deepEqual((await r.call(r.lead, 'questions_list')).body.questions, [], 'a new turn moves on from an unanswered question');
  const restarted = new Team(
    {
      list: () => [...r.people.values()],
      get: (id) => r.people.get(id),
      deskOccupied: () => false,
      officeDefault: undefined,
      hire: () => 'no',
      prompt: () => undefined,
      resume: () => undefined,
      kill: async () => ({}),
      tail: () => '',
      setTask() {},
    },
    { dataDir: r.dir, dir: r.dir, git: true, settings: () => r.settings, toast() {} },
  );
  t.after(() => restarted.stop());
  assert.deepEqual(restarted.questions('lead'), [], 'answered questions stay answered after a restart');
});

test('structured AskUser questions are listed like the Asks inbox and answered only while the same menu shows; permission prompts are refused', async (t) => {
  const r = await rig(t);
  await r.hire();
  r.set('sub1', 'needs_input', {
    ask: { kind: 'question', questions: [{ question: 'Which file should I create?', options: ['hello.txt', 'bye.txt', 'Other (type your answer)'], multiSelect: false }] },
    menu: FILE_MENU,
    waitingSince: Date.parse('2026-11-03T12:00:00Z'),
  });
  const [menu] = (await r.call(r.lead, 'questions_list')).body.questions;
  assert.equal(menu.kind, 'terminal');
  assert.match(menu.id, /^ask:floor:sub1:[0-9a-f]{12}$/);
  assert.equal(menu.question, 'Which file should I create?');
  assert.deepEqual(
    menu.options.map((o: { id: string; label: string }) => `${o.id} ${o.label}`),
    ['1 hello.txt', '2 bye.txt', '3 Other (type your answer)'],
  );
  assert.equal(menu.takesText, true);
  assert.equal(menu.answerable, true);
  assert.equal((await r.status()).body.workers[0].state, 'blocked_on_question');
  r.people.get('sub1')!.menu = {
    ...FILE_MENU,
    choices: FILE_MENU.choices.map((c) => (c.number === 2 ? { ...c, label: 'farewell.txt' } : c)),
  };
  assert.match((await r.call(r.lead, 'question_answer', { questionId: menu.id, optionId: '1' })).text, /question changed/);
  assert.deepEqual(r.answered, []);
  r.people.get('sub1')!.menu = FILE_MENU;
  assert.match((await r.call(r.lead, 'question_answer', { questionId: menu.id, optionId: '3', text: 'notes.txt' })).text, /not both/, 'a terminal question never drops the typed half of an answer');
  assert.deepEqual(r.answered, []);
  assert.equal((await r.call(r.lead, 'question_answer', { questionId: menu.id, optionId: '9' })).isError, true);
  assert.equal((await r.call(r.lead, 'question_answer', { questionId: menu.id, optionIds: ['1'] })).isError, true, 'single-select rejects optionIds');

  let releaseGate!: () => void;
  r.setAnswerGate(
    new Promise<void>((resolve) => {
      releaseGate = resolve;
    }),
  );
  const firstAnswer = r.call(r.lead, 'question_answer', { questionId: menu.id, optionId: '1' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match((await r.call(r.lead, 'question_answer', { questionId: menu.id, optionId: '1' })).text, /already being answered/, 'concurrent answers on one worker are rejected');
  releaseGate();
  assert.equal((await firstAnswer).isError, undefined);
  r.setAnswerGate(undefined);
  assert.deepEqual(r.answered, [{ id: 'sub1', reply: { menu: FILE_MENU, choice: 1 } }]);

  r.set('sub1', 'needs_input', { menu: undefined, ask: { kind: 'permission', tool: 'Execute', command: 'rm -rf build', risk: 'high' } });
  const [permission] = (await r.call(r.lead, 'questions_list')).body.questions;
  assert.equal(permission.kind, 'permission');
  assert.equal(permission.answerable, false);
  assert.match(permission.question, /Approve high-risk command: rm -rf build/);
  const refused = await r.call(r.lead, 'question_answer', { questionId: permission.id, optionId: '1' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /desk/);
  assert.equal(r.answered.length, 1);
  assert.equal((await r.call(r.lead, 'question_answer', { questionId: 'ask:floor:lead:permission', optionId: '1' })).isError, true, 'only the caller’s own subagents');
});

test('MCP steps through multi-question and multi-select AskUser menus directly without a Review screen, including Orchestrator watching cloud workers', async (t) => {
  const r = await rig(t);
  await r.hire();
  const step1: Menu = {
    question: 'Which hypervisor should we use?',
    choices: [
      { number: 1, label: 'UTM' },
      { number: 2, label: 'Tart' },
    ],
    freeText: false,
  };
  const step2: Menu = {
    question: 'Which protocols should we enable?',
    multiSelect: true,
    choices: [
      { number: 1, label: 'SSH' },
      { number: 2, label: 'VNC' },
    ],
    freeText: true,
  };
  r.set('sub1', 'needs_input', {
    ask: {
      kind: 'question',
      questions: [
        { question: step1.question!, options: ['UTM', 'Tart'], multiSelect: false },
        { question: step2.question!, options: ['SSH', 'VNC'], multiSelect: true },
      ],
    },
    menu: step1,
  });
  const [q1] = (await r.call(r.lead, 'questions_list')).body.questions;
  assert.equal(q1.answerable, true);
  assert.equal(q1.multiSelect, false);
  assert.equal(q1.takesText, false);
  assert.match((await r.call(r.lead, 'question_answer', { questionId: q1.id, text: 'custom' })).text, /does not accept a typed text answer/);
  assert.equal((await r.call(r.lead, 'question_answer', { questionId: q1.id, optionId: '1' })).isError, undefined);
  assert.deepEqual(r.answered.at(-1), { id: 'sub1', reply: { menu: step1, choice: 1 } });

  // Daemon advances directly to question 2 (no Review screen); stale q1 id is rejected.
  r.set('sub1', 'needs_input', { menu: step2 });
  assert.equal((await r.call(r.lead, 'question_answer', { questionId: q1.id, optionId: '1' })).isError, true);
  const [q2] = (await r.call(r.lead, 'questions_list')).body.questions;
  assert.notEqual(q2.id, q1.id);
  assert.equal(q2.multiSelect, true);
  assert.equal(q2.takesText, true);
  assert.equal((await r.call(r.lead, 'question_answer', { questionId: q2.id, optionId: '1' })).isError, true, 'multi-select requires optionIds');
  assert.match((await r.call(r.lead, 'question_answer', { questionId: q2.id, optionIds: ['x'] })).text, /x is not one of this question's options/);
  assert.equal((await r.call(r.lead, 'question_answer', { questionId: q2.id, optionIds: ['1', '2'], text: 'Port 2222' })).isError, undefined);
  assert.deepEqual(r.answered.at(-1), { id: 'sub1', reply: { menu: step2, choices: [1, 2], text: 'Port 2222' } });

  // Orchestrator watching a cloud worker sees its cloud.menu in questions_list and answers via owner bridge.
  const cloudMenu: Menu = {
    question: 'Deploy to staging?',
    choices: [
      { number: 1, label: 'Deploy now' },
      { number: 2, label: 'Hold' },
    ],
    freeText: false,
  };
  r.people.set(
    'cloud1',
    worker('cloud1', {
      name: 'Nimbus',
      kind: 'cloud',
      deskId: 'desk-8',
      status: 'needs_input',
      cloud: { computerId: 'comp-1', sessionUrl: 'https://app.factory.ai/sessions/c1', menu: cloudMenu },
    }),
  );
  const orch = await r.connect('orchestrator');
  assert.equal((await r.call(orch, 'team_watch', { worker: 'Nimbus', floor: 'floor' })).isError, undefined);
  const orchListed = await r.call(orch, 'questions_list', { floor: 'floor' });
  const cloudAsk = orchListed.body.questions.find((q: { worker: string }) => q.worker === 'cloud1');
  assert.ok(cloudAsk);
  assert.equal(cloudAsk.answerable, true);
  assert.equal(cloudAsk.question, 'Deploy to staging?');
  assert.equal((await r.call(orch, 'question_answer', { questionId: cloudAsk.id, optionId: '1' })).isError, undefined);
  assert.deepEqual(r.ownerActions.at(-1), { t: 'worker.answer', workerId: 'cloud1', menu: cloudMenu, choice: 1 });
});

test('team_wait returns as soon as news arrives, times out, cancels and never leaks listeners or blocks other calls', async (t) => {
  const r = await rig(t);
  await r.hire();
  await r.hire();
  const pixel = await r.connect('sub1');
  const listed = (await r.lead.listTools()).tools.find((tool) => tool.name === 'team_wait');
  assert.ok(listed?.outputSchema, 'team_wait advertises its structured output');

  const started = Date.now();
  const waiting = r.call(r.lead, 'team_wait', { until: ['report'], timeoutSec: 20 });
  await r.held(1);
  assert.equal((await r.status({ verbose: false })).isError, undefined, 'other calls are served while a wait is open');
  await r.call(pixel, 'team_report', { text: 'Finished the redirect.' });
  const woke = await waiting;
  assert.ok(Date.now() - started < 5000);
  assert.equal(woke.body.matched, true);
  assert.equal(woke.body.reason, 'report');
  assert.equal(woke.body.events[0].id, 'team:floor:1');
  assert.equal(woke.body.cursor, 'team:floor:1');
  assert.equal(r.team.watchers(), 0);
  assert.deepEqual((await r.status()).body.news, [], 'a local wait drains what it returned, like status');

  const timeout = await r.call(r.lead, 'team_wait', { until: ['report'], timeoutSec: 1 });
  assert.equal(timeout.body.matched, false);
  assert.equal(timeout.body.reason, 'timeout');
  assert.equal(r.team.watchers(), 0);

  const blocked = r.call(r.lead, 'team_wait', { until: ['blocked'], workers: ['Byte'], timeoutSec: 20 });
  await r.held(1);
  r.set('sub1', 'needs_input', { activity: 'ignored: not watched' });
  r.set('sub2', 'needs_input', { activity: 'Allow rm?' });
  const got = await blocked;
  assert.equal(got.body.reason, 'blocked');
  assert.deepEqual(
    got.body.events.map((e: { worker: string }) => e.worker),
    ['sub2'],
  );

  r.set('sub1', 'done');
  r.set('sub2', 'done');
  const rested = await r.call(r.lead, 'team_wait', { until: ['idle'], timeoutSec: 1 });
  assert.equal(rested.body.matched, false, 'a team already at rest is no news, so the wait does not return at once');
  const idle = r.call(r.lead, 'team_wait', { until: ['idle'], timeoutSec: 20 });
  await r.held(1);
  r.set('sub2', 'working');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(r.team.watchers(), 1, 'still waiting while one works');
  r.set('sub2', 'done');
  assert.equal((await idle).body.reason, 'idle', 'the team settling during the wait ends it');

  await r.status();
  const question = r.call(r.lead, 'team_wait', { timeoutSec: 20 });
  r.set('sub1', 'working');
  await new Promise((resolve) => setTimeout(resolve, 50));
  await r.call(pixel, 'team_report', { text: 'Which branch?', question: true });
  const asked = await question;
  assert.equal(asked.body.reason, 'question');
  assert.equal(asked.body.questions[0].id, asked.body.events[0].id);
  const again = await r.call(r.lead, 'team_wait', { until: ['question'], timeoutSec: 1 });
  assert.equal(again.body.matched, false, 'a question already heard does not end the next wait');
  assert.equal(again.body.questions[0].id, asked.body.events[0].id, 'it is still listed as waiting on the lead');
  assert.equal(again.body.news, undefined, 'events is the one list of what happened');

  // The plain curl-style client a remote bot uses: one POST, then it hangs up.
  const controller = new AbortController();
  const raw = fetch(r.url, {
    method: 'POST',
    signal: controller.signal,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', [OFFICE_MCP_WORKER_HEADER]: 'lead', Authorization: 'Bearer token-lead' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'team_wait', arguments: { until: ['report'], timeoutSec: 20 } } }),
  }).then((response) => response.text());
  await r.held(1);
  controller.abort();
  await assert.rejects(raw);
  for (let i = 0; i < 50 && r.team.watchers(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(r.team.watchers(), 0, 'a wait whose caller hung up unsubscribes');

  const held = Array.from({ length: 4 }, () => r.call(r.lead, 'team_wait', { until: ['report'], timeoutSec: 2 }));
  await r.held(4);
  assert.match((await r.call(r.lead, 'team_wait', { until: ['report'], timeoutSec: 1 })).text, /already have 4/);
  await Promise.all(held);
  assert.equal(r.team.watchers(), 0);
  for (const args of [{ timeoutSec: 601 }, { timeoutSec: 0 }, { until: [] }, { until: ['soon'] }, { workers: ['Nobody'] }, { since: 'later' }]) assert.equal((await r.call(r.lead, 'team_wait', args)).isError, true, JSON.stringify(args));

  r.settings.wakeLead = true;
  assert.ok(!(await r.lead.listTools()).tools.some((tool) => tool.name === 'team_wait'), 'wake notes replace waiting for a local lead');
  assert.match((await r.call(r.lead, 'team_wait', {})).text, /Wake the lead is on/);
});

test('team_wait returns every event that landed before it answered, and counts a terminal question that appears during it', async (t) => {
  const r = await rig(t);
  await r.hire();
  await r.hire();
  const blocked = r.call(r.lead, 'team_wait', { until: ['blocked'], timeoutSec: 20 });
  await r.held(1);
  // Both get stuck in one pass: the first wakes the wait, the second lands before it answers.
  r.set('sub1', 'needs_input', { activity: 'Allow rm?' });
  r.set('sub2', 'needs_input', { activity: 'Allow push?' });
  const got = await blocked;
  assert.deepEqual(
    got.body.events.map((e: { id: string }) => e.id),
    ['team:floor:1', 'team:floor:2'],
  );
  assert.equal(got.body.cursor, 'team:floor:2');

  r.set('sub1', 'working');
  r.set('sub2', 'working');
  const question = r.call(r.lead, 'team_wait', { until: ['question'], timeoutSec: 20 });
  await r.held(1);
  // When ask arrives before structured menu is populated, it reports not ready yet; once menu is set it becomes answerable.
  r.set('sub1', 'needs_input', { ask: { kind: 'question', questions: [{ question: 'Which file should I create?', options: ['hello.txt', 'bye.txt', 'Other (type your answer)'], multiSelect: false }] }, menu: undefined });
  const asked = await question;
  assert.equal(asked.body.reason, 'question');
  assert.deepEqual(asked.body.events, [], 'its needs_input news is not what this wait asked for');
  assert.equal(asked.body.questions[0].kind, 'terminal');
  assert.equal(asked.body.questions[0].answerable, false);
  assert.match(asked.body.questions[0].why, /not ready yet/);
  r.people.get('sub1')!.menu = FILE_MENU;
  const [drawn] = (await r.call(r.lead, 'questions_list')).body.questions;
  assert.equal(drawn.answerable, true, 'answerable once its structured menu is set');
  const again = await r.call(r.lead, 'team_wait', { until: ['question'], timeoutSec: 1 });
  assert.equal(again.body.matched, false, 'the same terminal question does not end the next wait');
  assert.equal(again.body.questions[0].id, drawn.id);
});

test('team_wait sends progress to a client that asked for it', async (t) => {
  const r = await rig(t);
  await r.hire();
  const beats: number[] = [];
  const result = await r.call(r.lead, 'team_wait', { until: ['report'], timeoutSec: 16 }, { onprogress: (p) => beats.push(p.progress), resetTimeoutOnProgress: true, timeout: 20_000 });
  assert.equal(result.body.reason, 'timeout');
  assert.deepEqual(beats, [15]);
});

test('the team event seq never goes back, so cursors stay valid after a lead leaves and the office restarts', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'team-seq-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const people = new Map([
    ['a', worker('a')],
    ['b', worker('b')],
    ['s', worker('s', { lead: 'b' })],
  ]);
  const workers: TeamWorkers = {
    list: () => [...people.values()],
    get: (id) => people.get(id),
    deskOccupied: () => false,
    officeDefault: undefined,
    hire: () => 'no',
    prompt: () => undefined,
    resume: () => undefined,
    kill: async () => ({}),
    tail: () => '',
    setTask() {},
  };
  const options = { dataDir: dir, dir, git: true, settings: () => ({ ...SUBAGENT_DEFAULTS, wakeLead: false }), toast() {} };
  const team = new Team(workers, options);
  await team.handle(people.get('s')!, { action: 'report', text: 'to b' });
  assert.equal(team.latest(), 1);
  people.delete('b');
  people.delete('s');
  team.onWorkerGone('b');
  team.stop();
  const restarted = new Team(workers, options);
  t.after(() => restarted.stop());
  assert.equal(restarted.latest(), 1);
});
