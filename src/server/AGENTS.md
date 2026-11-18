# Server

- Compiled by `tsconfig.server.json` (NodeNext, Node types, no DOM) into `dist/server` with `.js` relative imports. Keep `src/client` unimported here.
- Add CLI flags and `DROID_OFFICE_*` / `PORT` env options in `loadConfig` and `HELP` in `config.ts` (plus `.env.example`).
- Separate the two `.droid-office/` scopes: the office-wide directory (next to the started office: `droid-daemon.json`, floors, connections, prompts, devices, orchestrator) and each floor checkout's directory (workers, shell scrollback, decor, team, Whiteboard). Put new state files in the matching scope and list them in the **State.** bullet of [docs/guide/how-it-works.md](../../docs/guide/how-it-works.md).

## Local Droid daemon and PTY host

Local `agent` workers and the Mission Control `Orchestrator` run on one shared detached `droid daemon` (`local-daemon.ts`, persisted in office-wide `.droid-office/droid-daemon.json`), never in PTYs.

`ptyhost.ts` serves explicit `shell` desks and the boss laptop (`OFFICE_SHELL_ID`) only. It runs detached so shell terminals survive server restarts, and a newer server replaces a running host only when `PTY_PROTOCOL` (`ptys.ts`) changes. Bump `PTY_PROTOCOL` in the same change whenever editing code the host executes: `ptyhost.ts`, `screen.ts`, or `ptyhost.ts`'s imports from `ptys.ts` (`SCROLLBACK`, `readMessages`, `SpawnOpts`, `ToHost`, `FromHost`); server-only edits in `ptys.ts` need no bump.
