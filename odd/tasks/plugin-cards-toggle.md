# Plugin cards and toggle

Objective: in the Plugins section, enable/disable plugins, show how plugins relate to what they contribute, laid out as cards in a grid.
Branch: feat/plugin-cards-toggle · Delivery: ask-on-risk · Test runner: `npm test` (node:test), `orca plugin check .`

## Specs

- S1 Toggle: "mi serve poterli attivare dissativare". A plugin's switch writes `enabledPlugins["<name>@<marketplace>"]` in `~/.claude/settings.json`, leaving every other key and its order unchanged (2-space JSON, trailing newline). Before every write the current file is backed up; the latest backup can be restored from the panel. A change made by someone else after the panel read the file is not overwritten: the toggle refuses and asks to refresh. The panel says the change applies to new Claude Code sessions (or after `/reload-plugins`).
- S2 Relations: "vedere come sono collegate tra di loto". Assumption: the relations are marketplace → plugin → what the plugin contributes (skills, agents, commands, hooks, MCP servers), read from `~/.claude/plugins/installed_plugins.json` and each plugin's `installPath`. A plugin whose name exists in more than one marketplace is flagged.
- S3 Layout: "belli ordinati in delle card e gril". Plugins render as cards in a responsive grid, grouped by marketplace; each card shows name, version, on/off switch and its contribution counts, expandable to the names.
- S4 Fix from the first review: section tabs must not overflow the panel width.

- S5 Uninstall: "metti la possibilita di eliminarli". A plugin card can uninstall the plugin through the official CLI (`claude plugin uninstall <id> --scope <scope> --keep-data --json`), for every install record it has (user, and each project with its `projectPath` as cwd). It asks for confirmation first, backs up the settings files and `installed_plugins.json` it may touch, and keeps the plugin's data folder (so a reinstall gets it back).
- S6 Per project: "di attivarli sono in certe repo/progetti". For each project Claude Code knows (`projects` in `~/.claude.json`, folders that still exist), a plugin can be set to On, Off or Follow global (key removed). It is saved in the project's `.claude/settings.local.json` (only me, default) or `.claude/settings.json` (whole team, committed). The card shows the effective state per project with precedence local > project > user, and where each override lives. "Only in some repos" = global Off + On in those projects. Same safety as S1: backup before each write, refuse on a concurrent change.

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S2 | inline | done (13 tests green; real data checked) | 4b3784e |
| T2 | S1 | inline · Risk: item 1 (rewrites user settings), item 4 (concurrent writers) | done (24 tests green) | 59de991 |
| T3 | S1, S3, S4 | inline | done (plugin check clean; real round trip verified) | ad16a22 |
| T4 | S6 | inline | todo | |
| T5 | S1, S6 | inline · Risk: item 1 (rewrites project settings), item 4 | todo | |
| T6 | S5 | inline · Risk: item 1 (removes installed plugin files) | todo | |
| T7 | S5, S6 | inline | todo | |

## Log

- L1 (2026-11-24) User: "va bene come base ma in questa sezione mi serve poterli attivare dissativare vedere come sono collegate tra di loto e magari anche belli ordinati in delle card e gril"
- L2 Evidence: 24 plugins in installed_plugins.json, all present in enabledPlugins. Contributions live under installPath: skills/, agents/, commands/, hooks/hooks.json, .mcp.json. settings.json is 2-space JSON with a trailing newline. RDD: on (default).
- L3 T1: plugin.json may declare extra component paths (string or list) and inline mcpServers; skills may be nested (skills/<group>/<skill>). Both handled and tested.
- L4 T2: writes refuse on settingsVersion mismatch (FNV-1a of file text), unknown id, or unparsable file; backups in ~/.claude/backups/claude-config-manager; restore backs up the current file first and only accepts listed backup names; node adapter writes temp+rename and resolves symlinks. Independent verifier runs at feature end (Risk items 1, 4).
- L5 T3: tabs replaced by a Select (S4). Real-config check via worker: stripe on -> off -> byte-identical; restore of the first backup returned settings.json to its original sha (87be15da4e8a); a stale settingsVersion is refused with 'changed' and no write. My own mistaken third call (reusing the original version after a byte-identical round trip) briefly enabled stripe; restored within ~9s.
- L6 Independent verifier (Risk items 1, 4) on ad16a22: S1 fail, S2 partial, S3 pass, S4 pass. Blockers: (1) undo/restore had no settingsVersion check and could overwrite a newer settings.json; (2) writeText widened file mode 600 -> 644. Non-blocking: no write serialization in the worker, temp-name and same-ms backup collisions, malformed plugin.json crashed the inventory, `..`/absolute manifest paths escaped the plugin root, marketplace label used the first '@', no-op toggles still wrote. All fixed with tests in 78d596d (30 tests green; real worker refuses a stale restore and leaves sha 87be15da4e8a). Accepted as-is: JSON.stringify normalizes integer-like key order, number forms and escapes on write (restoring a backup gives back the exact bytes).
- L7 (2026-11-24) User: "metti la possibilita di eliminarli e di attivarli sono in certe repo/progetti"
- L8 Evidence for S5/S6: `claude plugin uninstall|enable|disable` support `--scope user|project|local` and `--json`; `claude plugin list --json` reports effective state per cwd. In ~/project-a, project settings set playwright false and `claude plugin list` there reports it disabled while home reports it enabled. In a temp project: user-false stripe + project-true -> enabled; project-true github + local-false -> disabled (local > project > user). installed_plugins.json keeps one record per scope (`scope`, `projectPath`). claude is at /opt/homebrew/bin/claude; the Orca worker PATH is unknown, so the adapter also looks in standard locations.
- L9 Recheck of the two verifier blockers on 78d596d: both fixed (stale restore refused byte-identical; mode 600 kept on settings and backup); 30/30 tests.
