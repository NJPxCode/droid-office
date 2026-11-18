import { rmSync } from 'node:fs';
import path from 'node:path';
import type { WorkerInfo } from '../../shared/protocol.js';
import { officePrompt, type PromptSource } from '../prompts.js';
import { PROMPTS, WORKER_TEAM_LEAD, WORKER_TEAM_SUBAGENT, WORKER_VISITS, workerBranchPolicy } from '../../shared/prompts.js';
import type { Worktrees } from '../worktrees.js';

interface LaunchSettingsContext {
  systemPrompt(): ((info: WorkerInfo) => string | undefined) | undefined;
  visitsOn(): boolean;
  plain: boolean;
  trees: Worktrees;
  prompts?: PromptSource;
}

/** Builds the office's per-session system prompt, without changing global Droid settings. */
export class WorkerLaunchSettings {
  constructor(
    dataDir: string,
    private context: LaunchSettingsContext,
  ) {
    // Old releases used a per-launch PTY hook script and settings overlay.
    rmSync(path.join(dataDir, 'droid-hooks.json'), { force: true });
    rmSync(path.join(dataDir, 'hook.cjs'), { force: true });
  }

  /** Pure system prompt string passed directly to `LocalDaemon.initializeSession({ workerSystemPrompt })`. */
  systemPromptText(info: WorkerInfo): string | undefined {
    const systemPrompt = this.context.systemPrompt();
    if (systemPrompt) {
      const custom = systemPrompt(info)?.trim();
      return custom || undefined;
    }
    // A plain folder has no branches to keep in sync.
    const branchPolicy = this.context.plain ? '' : workerBranchPolicy(this.context.trees.baseBranch() ?? this.context.trees.currentBranch(), this.context.trees.branchFile);
    const template = this.context.prompts?.text('worker.system') ?? PROMPTS['worker.system'].text;
    const team = info.lead ? WORKER_TEAM_SUBAGENT : WORKER_TEAM_LEAD;
    // Only a worker with no lead may visit the others; a subagent isn't told the visit tools exist.
    const visits = info.kind === 'agent' && !info.lead && this.context.visitsOn() ? WORKER_VISITS : '';
    let text = officePrompt(this.context.prompts, 'worker.system', { name: info.name, team, visits, branchPolicy });
    // A saved custom prompt from before {{team}} or {{visits}} existed may still hold those paragraphs verbatim.
    if (text && info.lead) {
      if (text.includes(WORKER_TEAM_LEAD)) text = text.replaceAll(WORKER_TEAM_LEAD, WORKER_TEAM_SUBAGENT);
      if (text.includes(WORKER_VISITS))
        text = text
          .replaceAll(WORKER_VISITS, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
    }
    // A saved system prompt from before visits existed still tells the worker about them.
    if (text && visits && !template.includes('{{visits}}')) text += `\n\n${visits}`;
    // A saved system prompt may predate the floor selector. Keep it, but don't let its generic
    // default-branch instructions override an explicit owner choice.
    if (text && branchPolicy && this.context.trees.selectedBranch() && !template.includes('{{branchPolicy}}')) text += `\n\n${branchPolicy}`;
    if (text && info.forkedFrom) {
      const files = info.worktree ? 'Your files are a private snapshot in your own worktree.' : 'You share this floor’s folder with the original worker. Files are not copied or isolated; coordinate before editing the same files.';
      text += `\n\nYou are ${info.name}, an independent fork of ${info.forkedFrom.name}'s conversation. ${files} The original may keep working. You are not the original worker or its subagent: use your own worker id and do not act on its terminal, worktree or team.`;
    }
    return text?.trim() || undefined;
  }
}
