# Release prep: launcher, known limits, privacy, publish

Objective: close the open points before making the repository public and announcing it.
Branch: feat/release-prep · Tests: `npm test`, `npm run typecheck`, `npm run test:panel`.

## Specs

- S1 Launch from any agent: an `agent-config` command (package `bin`) that starts the server, plus an `/agent-config` command inside each supported agent (Claude Code, Codex, Gemini CLI, Copilot CLI) that runs it. The app installs and removes those per-agent commands itself, in each agent's documented format; nothing else in the agents' config changes.
- S2 Known limits:
  - Claude: copying an MCP server into a project refuses secret-looking args, as the other agents do.
  - Redaction also catches tokens inside URL paths (e.g. webhook URLs).
  - A Gemini extension update that needs a new consent no longer hangs for 120 s: it fails at once with the command to run, or passes the documented non-interactive flag if one exists.
  - Undo where the agent's own CLI makes it possible: re-add a removed Codex MCP server, reinstall an uninstalled Gemini extension from its recorded source.
  - Find and fix the test that failed once out of five runs.
- S3 Copy an item from one agent to another (the S5 left for later in multi-agent): MCP servers and skills first, through each target provider's own write path and safety rules.
- S4 Privacy before publishing: no local paths, private project names or personal requests in tracked files; decide how to handle history.
- S5 Publish: make the repository public, prepare the Orca catalog entry, and draft a Reddit post.

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S2 | delegated writer A, parallel with T2 · Risk: item 1 | done (315 tests, 10 green runs) | eee4e78 |
| T2 | S1 | delegated writer B, parallel with T1 · Risk: item 5 (installs commands into agents) | done (309 tests; nothing installed in real homes) | b140afb |
| T3 | S3 | delegated writer, after T1 · Risk: item 1 | done; blocker fixed and rechecked | ff27ce0, 590f3f5 |
| T4 | S4 | inline: current files scrubbed; history rewrite after merge | in progress | 24617d0 |
| T5 | S5 | inline, after the user's go on history | todo | |

## Log

- L1 (2026-11-25) User asked to fix the four open points, make the repository public and create a Reddit post.
- L2 Personal data scrubbed from the current feature logs (24617d0). User chose to rewrite history before going public: mirror backup first, then remove local paths and private project names from every commit and set the GitHub noreply email as author, then force-push main. Done last, after this branch merges.
- L3 T2: `agent-config` bin (start, install-commands, uninstall-commands); per-agent files: Claude/Codex/Copilot skills `agent-config/SKILL.md`, Gemini `commands/agent-config.toml`; marked files only, never overwrites. Codex runs skills as `$agent-config`. npm publishing needs a build step (Node does not strip types under node_modules).
- L4 T1: the flaky test was a real bug: one 100 ms timeout shared by all requests in updates.test.ts failed under load (15/24 parallel runs); fixed at the cause. Gemini `extensions update` has no consent flag in 0.35.3, so it runs with stdin closed and returns the terminal command. Gemini reinstall undo needs `restore.acceptCommand` (moved into T3).
- L5 T3 (ff27ce0): copyToAgent for MCP and skills across the four providers, plus Gemini reinstall undo (approved command only), Claude team-file env/header refusal, agent-config hints; 374 unit + 53 panel tests. Verifier: one blocker, a secret inside a longer value (`Bearer ghp_…`, `token ghp_…`, `${X}ghp_…`, JSON) passed `argsHaveSecret` and reached CLI command lines; same root cause as a pre-existing Copilot view leak. Also: a cross-agent undo used fresh target versions, so it could remove a server the user edited after the copy; displayed commands were not shell-quoted; Gemini's skill hint used the SKILL.md name. One correction batch running.
- L6 Correction 590f3f5: redact.ts scans every word of a value (headers, Bearer, JSON, ${VAR}-prefixed); cross-agent undo carries `undoVersions`; displayed commands shell-quoted. Recheck: blocker and undo fixed. README updated. PR #6 feat/release-prep → main (merges cleanly). 386 unit + 54 panel tests.
- L7 Architecture review (improve-codebase-architecture): 5 candidates; #1 MCP policy module done in adbe4b5 (design-it-twice, design A plus constructors and a contract check). Verifier on adbe4b5: 2 blockers. (1) core/redact.ts TOKEN_PREFIX only matches a whole word, so 'sk-live-...$x', '...!' or '...#' passes and reaches claude/gemini/codex argv and Copilot team-file args (pre-existing detector gap, widened to Gemini moves). (2) gemini/read.ts drops 'type', so a ws server is written as http, and httpUrl+url silently drops url. Non-blocking: the contract check only catches an empty mcpDestinations list (make it behavioural); '${A}hunter2' under a secret-named key passes as a reference. Correction batch queued after #2/#4 (same files).
- L8 #2+#4 done in 65b55b2: core/guarded-change.ts (version check, backup, json/text/cli effect, post-condition re-read, restore undo; one wording per refusal) and providers/backup-actions.ts (BackupPlan per provider; router runs restore/snapshot). Claude CLI writes now re-read (did-not-change). ~/.claude.json version skip is the explicit 'unversioned' option. Not routed yet: claude uninstall, update-run, plugin-move. 410 tests. Correction batch for the #1 verifier blockers running.
