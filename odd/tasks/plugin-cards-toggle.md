# Plugin cards and toggle

Objective: in the Plugins section, enable/disable plugins, show how plugins relate to what they contribute, laid out as cards in a grid.
Branch: feat/plugin-cards-toggle · Delivery: ask-on-risk · Test runner: `npm test` (node:test), `orca plugin check .`

## Specs

- S1 Toggle: "mi serve poterli attivare dissativare". A plugin's switch writes `enabledPlugins["<name>@<marketplace>"]` in `~/.claude/settings.json`, leaving every other key and its order unchanged (2-space JSON, trailing newline). Before every write the current file is backed up; the latest backup can be restored from the panel. A change made by someone else after the panel read the file is not overwritten: the toggle refuses and asks to refresh. The panel says the change applies to new Claude Code sessions (or after `/reload-plugins`).
- S2 Relations: "vedere come sono collegate tra di loto". Assumption: the relations are marketplace → plugin → what the plugin contributes (skills, agents, commands, hooks, MCP servers), read from `~/.claude/plugins/installed_plugins.json` and each plugin's `installPath`. A plugin whose name exists in more than one marketplace is flagged.
- S3 Layout: "belli ordinati in delle card e gril". Plugins render as cards in a responsive grid, grouped by marketplace; each card shows name, version, on/off switch and its contribution counts, expandable to the names.
- S4 Fix from the first review: section tabs must not overflow the panel width.

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S2 | inline | done (13 tests green; real data checked) | 4b3784e |
| T2 | S1 | inline · Risk: item 1 (rewrites user settings), item 4 (concurrent writers) | todo | |
| T3 | S1, S3, S4 | inline | todo | |

## Log

- L1 (2026-11-24) User: "va bene come base ma in questa sezione mi serve poterli attivare dissativare vedere come sono collegate tra di loto e magari anche belli ordinati in delle card e gril"
- L2 Evidence: 24 plugins in installed_plugins.json, all present in enabledPlugins. Contributions live under installPath: skills/, agents/, commands/, hooks/hooks.json, .mcp.json. settings.json is 2-space JSON with a trailing newline. RDD: on (default).
- L3 T1: plugin.json may declare extra component paths (string or list) and inline mcpServers; skills may be nested (skills/<group>/<skill>). Both handled and tested.
