# HTML panel redesign

Objective: replace the Orca components panel with an HTML panel: tabs per class, global + per-project accordions, drag and drop to move/copy, backups. Inherits Orca's visual world (`--orca-*`), Operate mode, code-led.
Branch: feat/html-panel (stacked on feat/plugin-cards-toggle) · Delivery: ask-on-risk · Tests: `npm test`, `npm run typecheck`, Playwright on the panel with fixture data.

## Specs

- S1 Tabs: "teniamo il sistema.a tab per plugin, mcp,skills...." Tabs: Plugins, Skills, Agents, MCP, Hooks, each with its count.
- S2 Filter: "il filteter by name deve rimanere". One filter field, applied to the active tab across all its accordions.
- S3 Accordions: "non ci sara il select switches act on ma solamente un accordion globale e per progetto solo se ha delle cose proprie con dentro gli elemeti questo varra per tutte le classi (plugin,  skills mcp...)". In every tab: one "Global" accordion, plus one accordion per project only when that project has items of that class. No "Switches act on" select.
- S4 Backups: "avro la possibilita di creare back up". A "Create backup" action snapshots every settings file at once; the backups list and restore stay.
- S5 Drag and drop: "di fare il drag and drop per spostare un elemento". User choice: drag MOVES (item leaves its origin); holding ⌥ Option COPIES; backup before every change. Assumptions: every known project is a drop target even without items (a "drop on a project" target list appears while dragging); drops into a project default to "only me" (local) where the class has a local file, with an action to make it a team item; every drag has a keyboard alternative ("Move to…" / "Copy to…").
  Per class: skills/agents = the folder/file moves (a symlink moves as a link, never its target); MCP = `claude mcp add-json/remove --scope` (never hand-edit ~/.claude.json); hooks = the hook entry moves between settings files; plugins = to a project: on there and off globally; to global: on globally and the project override is cleared.
- S6 Design: "usa la skill /impeccable per disegnare un interfaccia carina econ tutte le feature neccesareie a un progetto simile". Keep earlier features: plugin switch, contents, shared-name note, uninstall with confirm, override clear, undo, backups list/restore, the team-vs-local warning, "applies to new sessions" note. Light and dark via `orca.on('theme')`.
- S7 Remove (from L7 of plugin-cards-toggle, "eliminarli"): plugins keep uninstall; skills/agents/MCP/hooks get Remove, backed up first (skills/agents go to a restorable trash).

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S3, S5, S7, S4 | delegated writer A (parallel with B): core per-scope inventory, move/copy/remove per class, snapshot, `buildView`/`runAction`, worker handlers · Risk: item 1, 3, 4 | done (99 tests, tsc 0); verifier running | 87ce012 |
| T2 | S1, S2, S3, S5, S6 | delegated writer B (parallel with A): HTML panel with transport shim, fixture, Playwright tests | done (24 Playwright tests) | 5708211 |
| T3 | all | inline: seam check, load in Orca, screenshots, independent verifier on T1 | done (102 unit + 24 panel tests, tsc 0, loaded in Orca with real data) | bca68e5 |

Route evidence: two independent units with disjoint surfaces (core+worker vs panel), joined by `src/adapters/view.ts`; each several hundred lines; parent context past the backstop.

## Log

- L1 (2026-11-24) User: "usa la skill /impeccable per disegnare un interfaccia carina econ tutte le feature neccesareie a un progetto simile 1 teniamo il sistema.a tab per plugin, mcp,skills.... il filteter by name deve rimanere non ci sara il select switches act on ma solamente un accordion globale e per progetto solo se ha delle cose proprie con dentro gli elemeti questo varra per tutte le classi (plugin,  skills mcp...) avro la possibilita di creare back up e di fare il drag and drop per spostare un elemento"
- L2 User chose "Pannello HTML" (Orca components have no drag events) and "Sposta, ⌥ per copiare".
- L3 Impeccable: Operate surface inside Orca's established world, so no concept tournament; styling only from `--orca-*`. `claude mcp add-json|remove` take `--scope local|user|project`. Native review START was declined by the user on feat/plugin-cards-toggle.
- L4 T1 (writer A): buildView/runAction in src/adapters/backend.ts; worker answers view.get/action.run serialized. Ports added: FileSystem.move/copy/linkTarget, PluginCli.mcpAdd/mcpRemove. ~/.claude.json is never written (restore of its backup refused as claude-owned). Relative-symlink skills are not movable. No undo for uninstall, snapshot, MCP removed from ~/.claude.json, and lossy plugin moves. Old components panel files deleted in the same commit.
- L5 Seam: manifest entry is panel/index.html; real view in Orca shows Global + projects with own items for every class (26 projects). `orca plugin shot --theme light` still rendered dark in Orca (the panel follows the app theme); light verified on the fixture.
- L6 Verifier on T1: S3/S4/S7 met, S5 blocked by a plugin move overwriting an existing destination override. Fixed in bca68e5 (refuse with `exists`), plus: a project settings file symlinked to the user settings is refused whatever its name; MCP names starting with '-' are refused before the CLI. Recheck: fixed, 102/102. Open advisory: the refusal for a symlinked settings file says "is your home folder", which is wrong wording for that case.
- L7 (2026-11-24) User: "Fai una roba quando hai finito controlla tutti quei progetti. Tra quella roba lì che si trova in global e duplicata in qualche altro progetto singolo ed elimina dai progetti singoli."
- L8 Done on real data with the backend Remove action (backups/trash first). Duplicate = same identity AND same content as the global item. Removed 13: plugin overrides equal to the global value (project-c: stripe, vercel; project-a: claude-code-setup, stripe, ui-ux-pro-max, vercel) and 7 byte-identical impeccable-* agents (project-b 3, project-a 4, all git-tracked, now showing as deletions in those repos). Left 11 same-name-but-different items (plugin overrides that differ from global; skills find-skills/impeccable and agent impeccable-finish-reviewer in project-b whose content differs). Rescan: 0 duplicates; effective plugin states unchanged.
