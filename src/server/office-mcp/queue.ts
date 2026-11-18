import { z } from 'zod';
import type { QueuedMessageItem, WorkerInfo, WorkerQueueState } from '../../shared/protocol.js';
import { formatBlockingSteerWarning, formatBlockingSummary, type BlockingToolState } from '../worker-queue.js';
import { floorNamed } from '../remote-office.js';
import { findMissionAgent, findWorker, hasOwnerAccess, missionControlRefusal } from './owner.js';
import { floorArg } from './team-events.js';
import { officeAccess, officeError, officeResult, ownFloor, type OfficeMcpCaller, type OfficeMcpDeps, type OfficeMcpServer, type OfficeMcpWorkers } from './index.js';

export type QueueCapableWorkers = Pick<OfficeMcpWorkers, 'get' | 'list' | 'queueState' | 'manageQueue' | 'clearQueue' | 'promoteQueue' | 'blockingTool'>;

const changesState = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function deliveryLabel(d: QueuedMessageItem['delivery']): string {
  if (d === 'after_turn') return 'after turn (queued)';
  if (d === 'steering') return 'mid-turn steer';
  return 'next step';
}

function formatQueueListText(w: WorkerInfo, state: WorkerQueueState, blocking?: BlockingToolState): string {
  const lines: string[] = [];
  if (!state.count) {
    lines.push(`${w.name} (${w.id}, ${w.status}): no queued messages.`);
  } else {
    lines.push(`${w.name} (${w.id}, ${w.status}): ${state.count} pending message${state.count === 1 ? '' : 's'}.`);
    for (const item of state.items) {
      const meta = [deliveryLabel(item.delivery), item.source, ...(item.preview ? ['preview'] : [])].join(', ');
      const extra = item.moreLines ? ` (+${item.moreLines} more line${item.moreLines === 1 ? '' : 's'})` : '';
      const idPart = item.id ? ` (${item.id})` : '';
      const indented = item.text.replace(/\n/g, '\n    ');
      lines.push(`  #${item.index}${idPart} [${meta}]: ${indented}${extra}`);
    }
    if (state.moreSteering) lines.push(`  +${state.moreSteering} more steering item${state.moreSteering === 1 ? '' : 's'}`);
    if (state.moreQueued) lines.push(`  +${state.moreQueued} more queued item${state.moreQueued === 1 ? '' : 's'}`);
  }
  if (blocking) {
    lines.push(`Blocking command: ${formatBlockingSummary(blocking)} — steers wait until this finishes; use promote with urgent: true (or office_worker_interrupt) to interrupt now.`);
  }
  return lines.join('\n');
}

function resolveTarget(caller: OfficeMcpCaller, deps: OfficeMcpDeps, workerRef: string, floor?: string): { worker: WorkerInfo; floorId: string; workers: QueueCapableWorkers } | { error: string; code?: string } {
  if (!caller.building) {
    const f = ownFloor(caller);
    const want = workerRef.trim().toLowerCase();
    const team = f.workers.list().filter((w) => w.lead === caller.worker.id);
    const hit = team.find((w) => w.id.toLowerCase() === want) ?? team.find((w) => w.name.toLowerCase() === want || w.name.replace(/ 🐚$/, '').toLowerCase() === want);
    if (!hit) {
      const other = f.workers.list().find((w) => w.id.toLowerCase() === want || w.name.toLowerCase() === want);
      return {
        error: other
          ? `${other.name} isn't one of your subagents${team.length ? `: yours are ${team.map((t) => t.name).join(', ')}` : ''}`
          : `No subagent called ${workerRef}${team.length ? `: yours are ${team.map((t) => t.name).join(', ')}` : ''}`,
        code: 'unknown_worker',
      };
    }
    return { worker: hit, floorId: f.id, workers: f.workers };
  }

  if (hasOwnerAccess(caller, deps.owner)) {
    const owner = deps.owner!;
    // Allow checkout paths via remote.floors() as team_* tools do, falling back to owner floor numbers/names/ids.
    let resolvedFloorRef = floor;
    if (floor && deps.remote) {
      const byRemote = floorNamed(deps.remote.floors(), floor);
      if (typeof byRemote !== 'string') resolvedFloorRef = byRemote.id;
    }
    const found = findWorker(owner.floors(), workerRef, resolvedFloorRef);
    if (typeof found === 'string') {
      const building = findMissionAgent(owner, workerRef);
      if (building) return { error: missionControlRefusal(building, 'worker_queue') };
      return { error: found, code: 'unknown_worker' };
    }
    const mcpFloor = deps.floor(found.worker.id);
    const remoteFloor = deps.remote?.floors().find((rf) => rf.id === found.floor.id);
    const workers: QueueCapableWorkers | undefined = mcpFloor?.workers ?? remoteFloor?.workers;
    if (!workers) {
      if (found.worker.cloud) return { error: `${found.worker.name} is a cloud worker and has no local message queue; use office_worker_interrupt to stop its turn or office_worker_prompt to send.` };
      return { error: `Queue controls are unavailable for ${found.worker.name} on floor ${found.floor.id}.` };
    }
    return { worker: found.worker, floorId: found.floor.id, workers };
  }

  const all = deps.remote?.floors() ?? [];
  const scoped =
    floor === undefined
      ? all
      : (() => {
          const named = floorNamed(all, floor);
          return typeof named === 'string' ? named : [named];
        })();
  if (typeof scoped === 'string') return { error: scoped };
  if (!scoped.length) return { error: 'No floor is open.' };
  const want = workerRef.trim().toLowerCase();
  const matches = scoped.flatMap((f) =>
    f.workers
      .list()
      .filter((w) => w.lead === caller.worker.id && (w.id.toLowerCase() === want || w.name.toLowerCase() === want || w.name.replace(/ 🐚$/, '').toLowerCase() === want))
      .map((w) => ({ f, w })),
  );
  if (matches.length !== 1) {
    return {
      error: matches.length ? 'That name occurs on several floors; use the worker id or specify floor' : 'No such subagent in your teams',
      code: matches.length ? 'ambiguous_worker' : 'unknown_worker',
    };
  }
  return { worker: matches[0].w, floorId: matches[0].f.id, workers: matches[0].f.workers };
}

export function register(server: OfficeMcpServer, deps: OfficeMcpDeps): void {
  server.tool(
    {
      name: 'worker_queue',
      description:
        'Inspect, delete, clear, or promote pending messages on a worker (mid-turn steers and after-turn queued messages). action: "list" reads pending items and any active blocking command; "delete" removes one item by id or index; "clear" cancels one item (id/index) or all; "promote" pulls queued message(s) forward to steer now (or pass urgent: true to interrupt a running turn/blocking command and deliver immediately).',
      inputSchema: z.strictObject({
        worker: z.string().trim().min(1).max(200).describe('Worker name or id.'),
        floor: floorArg,
        action: z.enum(['list', 'clear', 'delete', 'promote']).default('list').describe('list (default), delete, clear, or promote.'),
        id: z.string().trim().min(1).max(200).optional().describe('Queued message id from list (daemon requestId).'),
        index: z.number().int().min(1).max(200).optional().describe('1-based item index from list (omit on clear to clear all, or on promote to promote top queued item).'),
        all: z.boolean().optional().describe('Clear or promote all pending items (not with id or index).'),
        urgent: z.boolean().optional().describe('Promote only: interrupt running turn/blocking command and deliver immediately.'),
      }),
      annotations: changesState,
    },
    officeAccess.team,
    async (args, caller) => {
      if (args.floor && !caller.building) return officeError('Floor workers manage only their own floor');
      const itemId = args.id;
      if ((args.index !== undefined || itemId !== undefined) && args.all === true) return officeError('Choose an item (id or index) or all: true, not both.');
      if (args.action === 'list' && (args.index !== undefined || itemId !== undefined || args.all !== undefined || args.urgent !== undefined)) {
        return officeError('id, index, all, and urgent are only for delete, clear, or promote, not list.');
      }
      if ((args.action === 'clear' || args.action === 'delete') && args.urgent !== undefined) {
        return officeError(`urgent is only for action "promote", not "${args.action}".`);
      }
      if (args.action === 'delete' && args.index === undefined && itemId === undefined) {
        return officeError('action "delete" requires id or index; use action "clear" to clear all queued messages.');
      }

      const target = resolveTarget(caller, deps, args.worker, args.floor);
      if ('error' in target) return officeError(target.error, target.code);
      const { worker, floorId, workers } = target;
      if (worker.kind === 'shell') return officeError(`${worker.name} is a shell: shells have no Droid message queue.`);
      if (worker.cloud || worker.remote) return officeError(`${worker.name} runs remotely and has no local message queue.`);

      const empty: WorkerQueueState = { count: 0, items: [], moreSteering: 0, moreQueued: 0 };
      const readQueue = (): WorkerQueueState | undefined => workers.queueState?.(worker.id) ?? (workers.get(worker.id) ?? worker).queue;

      if (args.action === 'list') {
        const snapshot = readQueue();
        if (!workers.queueState && snapshot === undefined) return officeError(`Queue controls are unavailable on floor ${floorId}.`);
        const state = snapshot ?? empty;
        const blocking = workers.blockingTool?.(worker.id);
        return officeResult(formatQueueListText(worker, state, blocking), {
          worker: { id: worker.id, name: worker.name, floor: floorId, status: worker.status },
          ...state,
          ...(blocking ? { blockingTool: blocking, warning: formatBlockingSteerWarning(worker.name, blocking) } : {}),
        });
      }

      let resolvedIndex = args.index;
      if (itemId !== undefined) {
        const current = readQueue() ?? empty;
        const hit = current.items.find((it) => it.id === itemId);
        if (!hit) {
          const errText = `No queued message "${itemId}" on ${worker.name} (queue has ${current.count}).`;
          return {
            isError: true,
            content: [{ type: 'text', text: errText }],
            structuredContent: {
              code: 'queue_error',
              hint: errText,
              worker: { id: worker.id, name: worker.name, floor: floorId, status: worker.status },
              stillPending: current.count > 0,
              remaining: current,
            },
          };
        }
        if (resolvedIndex !== undefined && resolvedIndex !== hit.index) {
          return officeError(`Queued message "${itemId}" is at index ${hit.index}, not index ${resolvedIndex}.`);
        }
        resolvedIndex = hit.index;
      }

      if (args.action === 'clear' || args.action === 'delete') {
        if (!workers.clearQueue && !workers.manageQueue) return officeError(`Queue controls are unavailable on floor ${floorId}.`);
        const before = readQueue() ?? empty;
        const res = workers.clearQueue
          ? await workers.clearQueue(worker.id, resolvedIndex, itemId)
          : await (async () => {
              const out = await workers.manageQueue!(worker.id, args.action === 'delete' ? 'delete' : 'clear', { id: itemId, index: resolvedIndex });
              const err = typeof out === 'string' ? out : out?.error;
              const remaining = readQueue() ?? empty;
              const cleared = err ? [] : resolvedIndex !== undefined ? before.items.filter((it) => it.index === resolvedIndex) : before.items;
              return { ...(err ? { error: err } : {}), cleared, remaining };
            })();
        if (res.error) {
          const stillPending = res.remaining.count > 0;
          return {
            isError: true,
            content: [{ type: 'text', text: res.error }],
            structuredContent: {
              code: 'queue_error',
              hint: res.error,
              worker: { id: worker.id, name: worker.name, floor: floorId, status: worker.status },
              stillPending,
              remaining: res.remaining,
            },
          };
        }
        const msg = res.cleared.length ? `Cleared ${res.cleared.length} pending message${res.cleared.length === 1 ? '' : 's'} on ${worker.name}. Remaining: ${res.remaining.count}.` : `${worker.name} had no pending messages to clear.`;
        return officeResult(msg, {
          worker: { id: worker.id, name: worker.name, floor: floorId, status: worker.status },
          cleared: res.cleared,
          remaining: res.remaining,
        });
      }

      if (!workers.promoteQueue && !workers.manageQueue) return officeError(`Queue controls are unavailable on floor ${floorId}.`);
      const beforePromote = readQueue() ?? empty;
      const res = workers.promoteQueue
        ? await workers.promoteQueue(worker.id, { ...(itemId ? { id: itemId } : {}), index: resolvedIndex, all: args.all, urgent: args.urgent })
        : await (async () => {
            const target = resolvedIndex !== undefined ? beforePromote.items.find((it) => it.index === resolvedIndex) : (beforePromote.items.find((it) => it.delivery === 'after_turn') ?? beforePromote.items[0]);
            const out = await workers.manageQueue!(worker.id, 'promote', { id: itemId ?? target?.id, index: resolvedIndex ?? target?.index });
            const err = typeof out === 'string' ? out : out?.error;
            const remaining = readQueue() ?? empty;
            return { ...(err ? { error: err } : {}), promoted: err || !target ? [] : [target], delivery: 'steering' as const, stillPending: remaining.count > 0, remaining };
          })();
      if (res.error) {
        const stillPending = res.stillPending ?? res.remaining.count > 0;
        return {
          isError: true,
          content: [{ type: 'text', text: res.error }],
          structuredContent: {
            code: 'queue_error',
            hint: res.error,
            worker: { id: worker.id, name: worker.name, floor: floorId, status: worker.status },
            stillPending,
            remaining: res.remaining,
          },
        };
      }
      const blocking = !args.urgent && res.delivery !== 'already_delivered' ? workers.blockingTool?.(worker.id) : undefined;
      const warning = blocking ? formatBlockingSteerWarning(worker.name, blocking) : undefined;
      let outcome: string;
      if (res.delivery === 'interrupted') {
        outcome = `Interrupted ${worker.name}'s running turn and delivered ${res.promoted.length} promoted message${res.promoted.length === 1 ? '' : 's'} immediately.`;
      } else if (res.delivery === 'already_delivered') {
        outcome = `Queued message${res.promoted.length === 1 ? '' : 's'} on ${worker.name} had already been delivered as the previous turn ended (no longer pending in queue). Remaining queued: ${res.remaining.count}.`;
      } else {
        outcome = `Promoted ${res.promoted.length} message${res.promoted.length === 1 ? '' : 's'} on ${worker.name} (${res.delivery ?? 'steering'}). Remaining queued: ${res.remaining.count}.`;
      }
      return officeResult(warning ? `${outcome}\nWarning: ${warning}` : outcome, {
        worker: { id: worker.id, name: worker.name, floor: floorId, status: worker.status },
        promoted: res.promoted,
        delivery: res.delivery,
        stillPending: false,
        remaining: res.remaining,
        ...(blocking ? { blockingTool: blocking, warning } : {}),
      });
    },
  );
}
