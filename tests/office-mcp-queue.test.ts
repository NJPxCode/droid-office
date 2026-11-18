import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createOfficeMcp, OFFICE_MCP_PATH, OFFICE_MCP_WORKER_HEADER, type OfficeMcpFloor } from '../src/server/office-mcp/index.js';
import type { OwnerOffice } from '../src/server/office-mcp/owner.js';
import { RemoteOffice, type RemoteFloor } from '../src/server/remote-office.js';
import { RemoteWorkers } from '../src/server/remote-workers.js';
import { Team, type TeamWorkers } from '../src/server/team.js';
import { WhiteboardStore } from '../src/server/whiteboard.js';
import { BLOCKING_TOOL_MS, detectBlockingTool, formatBlockingSteerWarning, formatBlockingSummary, formatQueueBrief, type ActiveToolCall, type BlockingToolState } from '../src/server/worker-queue.js';
import { DESKS } from '../src/shared/layout.js';
import { SUBAGENT_DEFAULTS, type QueuedMessageItem, type WorkerInfo, type WorkerQueueState } from '../src/shared/protocol.js';

test('detectBlockingTool flags watch commands immediately and long-running tools after BLOCKING_TOOL_MS', () => {
  const watchMap = new Map<string, ActiveToolCall>([['s1', { tool: 'Execute', input: { command: 'gh run watch 12345 --exit-status' }, startedAt: 1_000 }]]);
  const watchHit = detectBlockingTool('working', watchMap, 1_200);
  assert.deepEqual(watchHit, {
    tool: 'Execute',
    command: 'gh run watch 12345 --exit-status',
    runningForMs: 200,
    reason: 'watch_command',
  });
  assert.equal(detectBlockingTool('needs_input', watchMap, 50_000), undefined);
  assert.equal(detectBlockingTool('done', watchMap, 50_000), undefined);

  const fastMap = new Map<string, ActiveToolCall>([['s1', { tool: 'Execute', input: { command: 'npm test' }, startedAt: 1_000 }]]);
  assert.equal(detectBlockingTool('working', fastMap, 1_000 + BLOCKING_TOOL_MS - 1), undefined);
  assert.deepEqual(detectBlockingTool('working', fastMap, 1_000 + BLOCKING_TOOL_MS + 500), {
    tool: 'Execute',
    command: 'npm test',
    runningForMs: BLOCKING_TOOL_MS + 500,
    reason: 'long_running',
  });

  // Non-shell tools do not misreport arbitrary `command` properties as shell commands.
  const nonShellMap = new Map<string, ActiveToolCall>([['s1', { tool: 'Read', input: { command: 'gh run watch 1' }, startedAt: 1_000 }]]);
  assert.equal(detectBlockingTool('working', nonShellMap, 1_200), undefined);
  assert.deepEqual(detectBlockingTool('working', nonShellMap, 1_000 + BLOCKING_TOOL_MS + 100), {
    tool: 'Read',
    runningForMs: BLOCKING_TOOL_MS + 100,
    reason: 'long_running',
  });

  const summary = formatBlockingSummary(watchHit!);
  assert.match(summary, /Execute: `gh run watch 12345 --exit-status`/);
  assert.match(formatBlockingSteerWarning('Pixel', watchHit!), /Pixel.*gh run watch 12345/);

  const brief = formatQueueBrief({
    count: 2,
    items: [
      { id: 'req-1', index: 1, text: 'Steer now', preview: false, moreLines: 0, source: 'droid', delivery: 'steering' },
      { id: 'req-2', index: 2, text: 'After turn', preview: false, moreLines: 0, source: 'droid', delivery: 'after_turn' },
    ],
    moreSteering: 0,
    moreQueued: 0,
  });
  assert.ok(brief);
  assert.match(brief, /Queued \(2\)/);
});

interface QueueRecord {
  id: string;
  text: string;
  delivery: QueuedMessageItem['delivery'];
  source: QueuedMessageItem['source'];
}

async function createQueueMcpRig(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-mcp-queue-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const people = new Map<string, WorkerInfo>();
  const tokens = new Map<string, string>();
  const queues = new Map<string, QueueRecord[]>();
  const activeTools = new Map<string, Map<string, ActiveToolCall>>();
  let seq = 0;
  let reqSeq = 0;
  const now = 10_000;
  let promoteMode: 'normal' | 'fail' | 'already_delivered' = 'normal';

  const syncWorkerQueue = (workerId: string): WorkerQueueState => {
    const list = queues.get(workerId) ?? [];
    const items: QueuedMessageItem[] = list.map((entry, idx) => {
      const lines = entry.text.split('\n');
      return {
        id: entry.id,
        index: idx + 1,
        text: entry.text,
        preview: false,
        moreLines: Math.max(0, lines.length - 1),
        source: entry.source,
        delivery: entry.delivery,
      };
    });
    const state: WorkerQueueState = { count: items.length, items, moreSteering: 0, moreQueued: 0 };
    const w = people.get(workerId);
    if (w) w.queue = items.length ? state : undefined;
    return state;
  };

  const enqueue = (workerId: string, text: string, delivery: QueuedMessageItem['delivery'], source: QueuedMessageItem['source'] = 'droid') => {
    const list = queues.get(workerId) ?? [];
    list.push({ id: `req-${++reqSeq}`, text, delivery, source });
    queues.set(workerId, list);
    return syncWorkerQueue(workerId);
  };

  const spawnWorker = (deskId: string, by: string, promptText: string | undefined, kind: WorkerInfo['kind'] = 'agent', lead?: string, cloud = false): WorkerInfo => {
    const id = `w-${++seq}`;
    const chosenDesk = deskId === 'auto' ? (DESKS.find((d) => ![...people.values()].some((w) => w.deskId === d.id))?.id ?? `desk-${seq}`) : deskId;
    const w: WorkerInfo = {
      id,
      name: `Worker${seq}`,
      kind,
      deskId: chosenDesk,
      color: '#ee6018',
      status: promptText ? 'working' : 'idle',
      acked: true,
      createdBy: by,
      createdAt: now + seq,
      cols: 100,
      rows: 30,
      open: false,
      ...(lead ? { lead } : {}),
      ...(cloud ? { cloud: { computerId: 'comp-1', sessionUrl: 'https://app.factory.ai/sessions/1' } } : {}),
    };
    people.set(id, w);
    tokens.set(id, `tok-${id}`);
    queues.set(id, []);
    return w;
  };

  const remoteStore = new RemoteWorkers(dir, () => {});
  let floorObj!: OfficeMcpFloor & RemoteFloor;
  const remote = new RemoteOffice(remoteStore, () => [floorObj]);
  t.after(() => remote.stop());
  const botCreated = remote.add('GrokLead');
  const botWorker = botCreated.worker;

  const blockingTool = (id: string, at = now): BlockingToolState | undefined => {
    const w = people.get(id);
    if (!w) return undefined;
    return detectBlockingTool(w.status, activeTools.get(id) ?? new Map(), at);
  };

  const workers: TeamWorkers & OfficeMcpFloor['workers'] & RemoteFloor['workers'] = {
    list: () => [...people.values()],
    get: (id) => people.get(id),
    authenticate: (id, token) => (tokens.get(id) === token ? people.get(id) : undefined),
    releaseLead: (leadId) => {
      for (const w of people.values()) if (w.lead === leadId) delete w.lead;
    },
    buildingAgent: (id) => id === botWorker.id,
    deskOccupied: (id) => [...people.values()].some((w) => w.deskId === id),
    officeDefault: undefined,
    hire: (deskId, by, promptText, _worktree, _c, lead) => spawnWorker(deskId, by, promptText, 'agent', lead),
    prompt: (id, text, queue) => {
      if (id === botWorker.id) return remote.tell(id, text, 'f-main');
      const w = people.get(id);
      if (!w) return 'No such worker';
      if (w.status === 'working') {
        enqueue(id, text, queue ? 'after_turn' : 'steering', 'droid');
      } else {
        w.status = 'working';
      }
      return undefined;
    },
    notice: (id, text) => {
      const w = people.get(id);
      if (w?.status !== 'working') return false;
      enqueue(id, text, 'steering', 'droid');
      return true;
    },
    urgentPrompt: async (id, text) => {
      const w = people.get(id);
      if (!w) return { error: 'No such worker' };
      const interrupted = w.status === 'working';
      activeTools.delete(id);
      w.status = 'working';
      w.activity = `Urgent: ${text.slice(0, 40)}`;
      return { interrupted };
    },
    queueState: (id) => (people.has(id) ? syncWorkerQueue(id) : undefined),
    blockingTool,
    clearQueue: async (id, index, itemId) => {
      const empty: WorkerQueueState = { count: 0, items: [], moreSteering: 0, moreQueued: 0 };
      const list = queues.get(id);
      if (!list) return { error: 'No such worker', cleared: [], remaining: empty };
      const current = syncWorkerQueue(id);
      if (itemId !== undefined || index !== undefined) {
        const pos = itemId !== undefined ? list.findIndex((it) => it.id === itemId) : (index ?? 1) - 1;
        if (pos < 0 || pos >= list.length) {
          return { error: `No queued message #${index ?? itemId} on ${people.get(id)?.name}`, cleared: [], remaining: current };
        }
        const [removed] = current.items.slice(pos, pos + 1);
        list.splice(pos, 1);
        return { cleared: removed ? [removed] : [], remaining: syncWorkerQueue(id) };
      }
      const cleared = [...current.items];
      list.length = 0;
      return { cleared, remaining: syncWorkerQueue(id) };
    },
    promoteQueue: async (id, opts = {}) => {
      const empty: WorkerQueueState = { count: 0, items: [], moreSteering: 0, moreQueued: 0 };
      const list = queues.get(id);
      const w = people.get(id);
      if (!list || !w) return { error: 'No such worker', promoted: [], stillPending: false, remaining: empty };
      const current = syncWorkerQueue(id);
      if (!current.count) return { error: `${w.name} has no queued messages to promote.`, promoted: [], stillPending: false, remaining: empty };

      let indices: number[];
      if (opts.id !== undefined) {
        const pos = list.findIndex((it) => it.id === opts.id);
        if (pos < 0) return { error: `No queued message ${opts.id}`, promoted: [], stillPending: current.count > 0, remaining: current };
        indices = [pos];
      } else if (opts.index !== undefined) {
        if (opts.index < 1 || opts.index > list.length) {
          return { error: `No queued message #${opts.index} on ${w.name} (queue has ${list.length}).`, promoted: [], stillPending: current.count > 0, remaining: current };
        }
        indices = [opts.index - 1];
      } else if (opts.all) {
        indices = list.map((_, idx) => idx);
      } else {
        const firstQueued = list.findIndex((it) => it.delivery === 'after_turn');
        indices = [firstQueued >= 0 ? firstQueued : 0];
      }

      const promoted = indices.map((pos) => current.items[pos]);
      if (promoteMode === 'fail') {
        const target = promoted[0];
        return {
          error: `Daemon update_queue failed on ${w.name}. Message is still pending in queue (#${target.index} [after turn]; ${current.count} pending).`,
          promoted: [],
          stillPending: true,
          remaining: current,
        };
      }
      if (promoteMode === 'already_delivered') {
        for (const pos of [...indices].reverse()) list.splice(pos, 1);
        w.status = 'done';
        return { promoted, delivery: 'already_delivered', stillPending: false, remaining: syncWorkerQueue(id) };
      }
      if (opts.urgent) {
        for (const pos of [...indices].reverse()) list.splice(pos, 1);
        activeTools.delete(id);
        return { promoted, delivery: 'interrupted', stillPending: false, remaining: syncWorkerQueue(id) };
      }
      for (const pos of indices) list[pos].delivery = 'steering';
      return { promoted, delivery: 'steering', stillPending: false, remaining: syncWorkerQueue(id) };
    },
    resume: (id) => {
      const w = people.get(id);
      if (w) w.status = 'working';
      return undefined;
    },
    kill: async (id) => {
      people.delete(id);
      queues.delete(id);
      return {};
    },
    tail: () => '',
    setTask: (id, task) => {
      const w = people.get(id);
      if (w) w.task = task;
    },
  };

  const team = new Team(
    {
      ...workers,
      get: (id) => workers.get(id) ?? (id === botWorker.id ? botWorker : undefined),
    },
    {
      dataDir: path.join(dir, '.droid-office'),
      dir,
      git: false,
      settings: () => ({ ...SUBAGENT_DEFAULTS, worktree: false }),
      toast: () => {},
      now: () => now,
    },
  );
  t.after(() => team.stop());

  const whiteboard = new WhiteboardStore(path.join(dir, '.droid-office', 'wb'), () => {});
  t.after(() => whiteboard.stop());

  floorObj = {
    id: 'f-main',
    name: 'main-repo',
    def: { name: 'main-repo' },
    dir,
    workers,
    team,
    visits: { handle: () => ({ status: 400, body: { error: 'off' } }), cannotVisit: () => 'off' },
    whiteboard,
  };

  const owner: OwnerOffice = {
    floors: () => [{ id: 'f-main', name: 'main-repo', workers: workers.list() }],
    mission: () => [{ worker: botWorker, team: [] }],
    tail: () => '',
    act: async (_by, msg) => {
      const notes: string[] = [];
      if (msg.t === 'worker.prompt') {
        const wid = String(msg.workerId);
        const text = String(msg.prompt);
        if (msg.urgent === true) {
          const res = await workers.urgentPrompt!(wid, text);
          if (res.interrupted) notes.push(`Interrupted ${workers.get(wid)?.name}'s running turn and delivered the urgent prompt`);
          return { ...(res.error ? { error: res.error } : {}), workerId: wid, notes };
        }
        const blocking = msg.queue !== true ? blockingTool(wid) : undefined;
        const err = workers.prompt(wid, text, msg.queue === true);
        if (!err && blocking) notes.push(`${workers.get(wid)?.name} is inside a blocking command (${blocking.tool}: \`${blocking.command}\`)`);
        return { ...(err ? { error: err } : {}), workerId: wid, notes };
      }
      return { notes };
    },
  };

  const mcp = createOfficeMcp({
    settings: () => ({ ...SUBAGENT_DEFAULTS, worktree: false }),
    floor: (workerId) => (people.has(workerId) ? floorObj : undefined),
    remote,
    owner,
    remoteTransport: { hostname: () => 'mac.tail.ts.net', owner: () => 'nik@example.com' },
  });

  const localMcp = createOfficeMcp({
    settings: () => ({ ...SUBAGENT_DEFAULTS, worktree: false }),
    floor: (workerId) => (people.has(workerId) ? floorObj : undefined),
    remote,
  });

  const httpServer = createServer((req, res) => {
    if (req.headers['x-local-mcp'] === '1') {
      void localMcp.handle(req, res);
      return;
    }
    req.headers.host = 'mac.tail.ts.net';
    req.headers['tailscale-user-login'] = 'nik@example.com';
    void mcp.handle(req, res);
  });
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  t.after(async () => {
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
  const port = (httpServer.address() as AddressInfo).port;

  const botClient = new Client({ name: 'bot-test', version: '1.0.0' });
  t.after(() => botClient.close());
  await botClient.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${OFFICE_MCP_PATH}`), {
      requestInit: { headers: { Authorization: `Bearer ${botCreated.token}` } },
    }),
  );

  const connectLocal = async (workerId: string) => {
    const c = new Client({ name: 'floor-lead', version: '1.0.0' });
    t.after(() => c.close());
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${OFFICE_MCP_PATH}`), {
        requestInit: {
          headers: {
            'x-local-mcp': '1',
            Authorization: `Bearer ${tokens.get(workerId)!}`,
            [OFFICE_MCP_WORKER_HEADER]: workerId,
          },
        },
      }),
    );
    return c;
  };

  const setActiveTool = (workerId: string, tool: string, command: string) => {
    activeTools.set(workerId, new Map([['t1', { tool, input: { command }, startedAt: now - 500 }]]));
  };

  return {
    people,
    queues,
    spawnWorker,
    botWorker,
    botClient,
    connectLocal,
    setActiveTool,
    setPromoteMode: (mode: 'normal' | 'fail' | 'already_delivered') => {
      promoteMode = mode;
    },
  };
}

test('MCP end-to-end: structured WorkerInfo.queue list/delete/clear/promote by id and index, blocking hints, and urgent interrupt', async (t) => {
  const rig = await createQueueMcpRig(t);

  const hired = await rig.botClient.callTool({
    name: 'team_hire',
    arguments: { floor: 'f-main', title: 'Watch CI', brief: 'Monitor CI and ship', worktree: false },
  });
  assert.equal(hired.isError, undefined);
  const subId = (hired.structuredContent!.worker as { id: string }).id;
  rig.setActiveTool(subId, 'Execute', 'gh run watch 98765');

  const standalone = rig.spawnWorker('desk-5', 'Owner', 'Standalone task', 'agent');
  const shell = rig.spawnWorker('desk-8', 'Owner', 'Shell', 'shell');
  const cloud = rig.spawnWorker('desk-9', 'Owner', 'Cloud', 'cloud', undefined, true);

  // 1. Default team_message (`queue` omitted -> false) steers mid-turn and warns about `gh run watch`.
  const steered = await rig.botClient.callTool({
    name: 'team_message',
    arguments: { worker: subId, text: 'Stop watching old run; check commit abc123.' },
  });
  assert.equal(steered.isError, undefined);
  assert.equal((steered.structuredContent?.blockingTool as { reason: string })?.reason, 'watch_command');
  assert.match((steered.content[0] as { text: string }).text, /Warning: .*gh run watch 98765/);

  // 2. Explicit `queue: true` queues behind the turn (`queued_turn`).
  const afterTurn = await rig.botClient.callTool({
    name: 'team_message',
    arguments: { worker: subId, text: 'After this turn, update CHANGELOG.md.', queue: true },
  });
  assert.equal(afterTurn.isError, undefined);
  assert.equal(afterTurn.structuredContent?.delivery, 'queued_turn');

  // Combining `queue: true` and `urgent: true` is rejected on both team_message and office_worker_prompt.
  assert.equal((await rig.botClient.callTool({ name: 'team_message', arguments: { worker: subId, text: 'Conflict', queue: true, urgent: true } })).isError, true);
  assert.equal((await rig.botClient.callTool({ name: 'office_worker_prompt', arguments: { workerId: standalone.id, prompt: 'Conflict', queue: true, urgent: true } })).isError, true);

  // 3. `team_status` and `office_roster` both expose `queuedMessages` and `blockingTool`.
  const status = await rig.botClient.callTool({ name: 'team_status', arguments: { verbose: false } });
  assert.equal(status.isError, undefined);
  const statusWorkers = status.structuredContent?.workers as Array<{ id: string; queuedMessages?: { count: number }; blockingTool?: { command: string } }>;
  assert.equal(statusWorkers[0].id, subId);
  assert.equal(statusWorkers[0].queuedMessages?.count, 2);
  assert.equal(statusWorkers[0].blockingTool?.command, 'gh run watch 98765');
  assert.match((status.content[0] as { text: string }).text, /Blocking: Execute: `gh run watch 98765`/);
  assert.match((status.content[0] as { text: string }).text, /Queued \(2\)/);

  const rosterRes = await rig.botClient.callTool({ name: 'office_roster', arguments: {} });
  assert.equal(rosterRes.isError, undefined);
  assert.match((rosterRes.content[0] as { text: string }).text, /Blocking command: Execute: `gh run watch 98765`/);
  assert.match((rosterRes.content[0] as { text: string }).text, /Queued \(2\)/);

  // 4. `worker_queue` list shows structured daemon request ids (`id`) + delivery + blockingTool.
  const listed = await rig.botClient.callTool({ name: 'worker_queue', arguments: { worker: subId, action: 'list' } });
  assert.equal(listed.isError, undefined);
  assert.equal(listed.structuredContent?.count, 2);
  const items = listed.structuredContent?.items as Array<{ id: string; index: number; delivery: string; text: string }>;
  assert.ok(items[0].id);
  assert.equal(items[0].delivery, 'steering');
  assert.equal(items[1].delivery, 'after_turn');
  assert.match((listed.content[0] as { text: string }).text, new RegExp(`#1 \\(${items[0].id}\\) \\[mid-turn steer, droid\\]`));

  // Validation guards on delete/list/clear/id+index mismatch/unknown id.
  assert.equal((await rig.botClient.callTool({ name: 'worker_queue', arguments: { worker: subId, action: 'delete' } })).isError, true, 'delete requires id or index');
  assert.equal((await rig.botClient.callTool({ name: 'worker_queue', arguments: { worker: subId, action: 'list', id: items[0].id } })).isError, true);
  assert.equal((await rig.botClient.callTool({ name: 'worker_queue', arguments: { worker: subId, action: 'delete', id: items[0].id, index: 2 } })).isError, true, 'mismatched id + index');
  const unknownId = await rig.botClient.callTool({ name: 'worker_queue', arguments: { worker: subId, action: 'delete', id: 'req-missing' } });
  assert.equal(unknownId.isError, true);
  assert.equal(unknownId.structuredContent?.code, 'queue_error');
  assert.equal(unknownId.structuredContent?.stillPending, true);

  // 5. `worker_queue` delete with `id` removes just that item, leaving the after-turn item intact!
  const deletedOne = await rig.botClient.callTool({ name: 'worker_queue', arguments: { worker: subId, action: 'delete', id: items[0].id } });
  assert.equal(deletedOne.isError, undefined, (deletedOne.content[0] as { text: string })?.text);
  assert.equal((deletedOne.structuredContent!.remaining as { count: number }).count, 1);

  // 6. Promote with `urgent: true` interrupts `gh run watch` and delivers immediately!
  const promotedUrgent = await rig.botClient.callTool({
    name: 'worker_queue',
    arguments: { worker: subId, action: 'promote', id: items[1].id, urgent: true },
  });
  assert.equal(promotedUrgent.isError, undefined, (promotedUrgent.content[0] as { text: string })?.text);
  assert.equal(promotedUrgent.structuredContent?.delivery, 'interrupted');
  assert.equal((promotedUrgent.structuredContent!.remaining as { count: number }).count, 0);
  assert.match((promotedUrgent.content[0] as { text: string }).text, /Interrupted/);

  // 7. Failed promote preserves stillPending: true, and drained turn reports delivery: 'already_delivered'.
  await rig.botClient.callTool({ name: 'team_message', arguments: { worker: subId, text: 'Keep me visible on failed promote', queue: true } });
  rig.setPromoteMode('fail');
  const failedPromote = await rig.botClient.callTool({ name: 'worker_queue', arguments: { worker: subId, action: 'promote' } });
  assert.equal(failedPromote.isError, true);
  assert.equal(failedPromote.structuredContent?.code, 'queue_error');
  assert.equal(failedPromote.structuredContent?.stillPending, true);
  assert.match((failedPromote.content[0] as { text: string }).text, /Message is still pending in queue/);

  rig.setPromoteMode('already_delivered');
  const drainedPromote = await rig.botClient.callTool({ name: 'worker_queue', arguments: { worker: subId, action: 'promote' } });
  assert.equal(drainedPromote.isError, undefined);
  assert.equal(drainedPromote.structuredContent?.delivery, 'already_delivered');
  assert.equal(drainedPromote.structuredContent?.stillPending, false);
  assert.match((drainedPromote.content[0] as { text: string }).text, /already been delivered/);
  rig.setPromoteMode('normal');

  // 8. Standalone floor worker queue + shell/cloud guards + floor lead scope check.
  await rig.botClient.callTool({ name: 'office_worker_prompt', arguments: { workerId: standalone.id, prompt: 'Queued on standalone worker', queue: true } });
  const soloQueue = await rig.botClient.callTool({ name: 'worker_queue', arguments: { worker: standalone.name, action: 'list' } });
  assert.equal(soloQueue.isError, undefined);
  assert.equal(soloQueue.structuredContent?.count, 1);
  assert.equal((await rig.botClient.callTool({ name: 'worker_queue', arguments: { worker: standalone.id, action: 'clear' } })).isError, undefined);

  assert.match(((await rig.botClient.callTool({ name: 'worker_queue', arguments: { worker: shell.id } })).content[0] as { text: string }).text, /shells have no Droid message queue/);
  assert.match(((await rig.botClient.callTool({ name: 'worker_queue', arguments: { worker: cloud.id } })).content[0] as { text: string }).text, /runs remotely/);

  const floorLead = rig.spawnWorker('desk-6', 'Owner', 'Floor lead', 'agent');
  const floorLeadSub = rig.spawnWorker('desk-7', floorLead.name, 'Child task', 'agent', floorLead.id);
  const localClient = await rig.connectLocal(floorLead.id);
  assert.equal((await localClient.callTool({ name: 'worker_queue', arguments: { worker: floorLeadSub.id } })).isError, undefined);
  const peerRefused = await localClient.callTool({ name: 'worker_queue', arguments: { worker: standalone.id } });
  assert.equal(peerRefused.isError, true);
  assert.match((peerRefused.content[0] as { text: string }).text, /isn't one of your subagents/);
});
