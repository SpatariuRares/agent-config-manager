# Updates for plugins, skills and MCP servers

Objective: show where each item updates from, check for updates on demand, and update one item or all of a kind from the panel.
Branch: feat/updates (stacked on feat/html-panel) · Delivery: ask-on-risk · Tests: `npm test`, `npm run typecheck`, `npm run test:panel`.

## Specs

- S1 Update: "aggiungi anche l'uptate a plugin, mcp , skills e tutt o". Per class:
  - plugins: `claude plugin update <id> --scope <scope> --json`; plus "Refresh marketplaces" (`claude plugin marketplace update`). Version before/after read from installed_plugins.json.
  - skills installed by the `skills` CLI (listed in ~/.agents/.skill-lock.json, e.g. mattpocock/skills, greensock/gsap-skills): `npx -y skills update <name> -g -y`. Check: compare the lock's `skillFolderHash` with the remote git tree sha of `skillPath`'s folder (one GitHub trees call per repo, not per skill).
  - MCP servers launched from a version-pinned npm package (`npx pkg@1.2.3`, `npx --package=pkg@1.2.3 …`, e.g. context7's `@upstash/context7-mcp@2.2.5`): latest from the npm registry; update rewrites the pinned version through `claude mcp remove` + `claude mcp add-json` in the same scope (never edits ~/.claude.json).
  - manual sources (e.g. an MCP binary under /opt/homebrew/bin): shown as "managed by Homebrew" with the command to run; the app never runs it.
  - local skills, agents, hooks, unpinned or remote MCP servers: no update source; the panel says so.
- S2 Check on demand only: a "Check for updates" button; no background polling. Results show per item (available / up to date / unknown with reason) and per tab ("3 updates").
- S3 Update all: per tab, updates every item the last check marked available, one at a time, reporting each outcome.
- S4 Safety: a plugin update that needs a marketplace-declared command approved is never auto-accepted; the panel shows the command and only an explicit click sends `acceptCommand`. Settings files touched are backed up first; every outcome (including partial MCP updates) is reported honestly.

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1, S2, S3, S4 | delegated writer A (parallel with B): update sources in the view, `checkUpdates`, update actions, worker `updates.check` · Risk: item 5 (runs installers/CLIs), item 1 | done (133 tests, tsc 0); verifier: no blockers | f372436 |
| T2 | S1, S2, S3, S4 | delegated writer B (parallel with A): panel UI for sources, check, update, update all, confirm; fixture support; Playwright | done (35 panel tests) | 764384c |
| T3 | all | inline: seam check, real read-only check in Orca, verifier on T1 | done | f8c1b43 |

Route evidence: two disjoint units joined by `src/adapters/view.ts` (extended in this branch's first commit); parent context past the backstop.

## Log

- L1 (2026-11-24) User: "aggiungi anche l'uptate a plugin, mcp , skills e tutt o"
- L2 Evidence: `claude plugin update <plugin> [--scope] [--json] [-y] [--accept-command <sha256>]`; `claude plugin marketplace update [name]`; marketplace manifests mostly lack versions (14/317), so availability for plugins is unknown until an update runs, unless a version or commit can be compared. ~/.agents/.skill-lock.json: 64 skills, all github, with sourceUrl, skillPath, skillFolderHash. `skills` CLI has `update [skills...] -g -y` and no check command. Real MCP: context7 = `npx -y --package=@upstash/context7-mcp@2.2.5 -- context7-mcp`; engram = /opt/homebrew/bin/engram; others local binaries or http.
- L3 Decisions (parent, no question asked): check only on demand; never auto-accept a plugin's marketplace command.
- L4 T1 (writer A): real data has update sources for 24 plugins, 25 skills (7 GitHub repos → 7 calls per check), MCP: context7 and chrome-devtools-mcp (npm), engram (Homebrew). Most claude-plugins-official plugins stay "unknown" until updated: that marketplace copy is not a git checkout and declares versions for only 14/317. Ports: PluginCli.pluginUpdate/marketplaceUpdate/skillsUpdate/git, Http.getJson (fetch, 10 s timeout). The shownCommand JSON shape of `claude plugin update` is parsed leniently and is unconfirmed against real output.
- L5 Verifier on T1: S1–S4 met, no blockers (argv only, no -y, sha passed through exactly, MCP rewrite backs up and keeps every other field). Fixed in f8c1b43: npm latest trimmed, non-semver latest refused as check-failed instead of "already latest", acceptCommand must be hex. Not verified (needs network or real tools): the real `claude plugin update --json` shownCommand shape, npm registry URL for scoped packages without encoding, skillFolderHash being the git tree sha.
- L6 Real read-only check through the Orca worker: 52 sources, 16 up to date, 4 available (skill find-skills, MCP context7 2.2.5 → 4.8.0, MCP chrome-devtools-ext in project-c → 1.14.0, plugin engram 0.1.23 → 0.1.28), 32 unknown (20 official plugins "checked when you update", 2 skills moved upstream, engram via Homebrew). No errors; settings.json unchanged. No update was run.
- L7 A `git commit -am` for the doc had swept in-progress panel files; the three unpushed commits were redone (df44c0c, f8c1b43, 764384c).
