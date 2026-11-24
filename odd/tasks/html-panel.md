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
| T1 | S3, S5, S7, S4 | delegated writer A (parallel with B): core per-scope inventory, move/copy/remove per class, snapshot, `buildView`/`runAction`, worker handlers · Risk: item 1, 4 | todo | |
| T2 | S1, S2, S3, S5, S6 | delegated writer B (parallel with A): HTML panel with transport shim, fixture, Playwright tests | todo | |
| T3 | all | inline: seam check, load in Orca, screenshots, independent verifier on T1 | todo | |

Route evidence: two independent units with disjoint surfaces (core+worker vs panel), joined by `src/adapters/view.ts`; each several hundred lines; parent context past the backstop.

## Log

- L1 (2026-11-24) User: "usa la skill /impeccable per disegnare un interfaccia carina econ tutte le feature neccesareie a un progetto simile 1 teniamo il sistema.a tab per plugin, mcp,skills.... il filteter by name deve rimanere non ci sara il select switches act on ma solamente un accordion globale e per progetto solo se ha delle cose proprie con dentro gli elemeti questo varra per tutte le classi (plugin,  skills mcp...) avro la possibilita di creare back up e di fare il drag and drop per spostare un elemento"
- L2 User chose "Pannello HTML" (Orca components have no drag events) and "Sposta, ⌥ per copiare".
- L3 Impeccable: Operate surface inside Orca's established world, so no concept tournament; styling only from `--orca-*`. `claude mcp add-json|remove` take `--scope local|user|project`. Native review START was declined by the user on feat/plugin-cards-toggle.
