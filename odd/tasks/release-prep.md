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
| T3 | S3 | delegated writer, after T1 · Risk: item 1 | running (with Gemini reinstall undo, Claude env secrets, start hint) | |
| T4 | S4 | inline | todo | |
| T5 | S5 | inline, after the user's go on history | todo | |

## Log

- L1 (2026-11-25) User asked to fix the four open points, make the repository public and create a Reddit post.
- L2 Personal data scrubbed from the current feature logs (24617d0). User chose to rewrite history before going public: mirror backup first, then remove local paths and private project names from every commit and set the GitHub noreply email as author, then force-push main. Done last, after this branch merges.
- L3 T2: `agent-config` bin (start, install-commands, uninstall-commands); per-agent files: Claude/Codex/Copilot skills `agent-config/SKILL.md`, Gemini `commands/agent-config.toml`; marked files only, never overwrites. Codex runs skills as `$agent-config`. npm publishing needs a build step (Node does not strip types under node_modules).
- L4 T1: the flaky test was a real bug: one 100 ms timeout shared by all requests in updates.test.ts failed under load (15/24 parallel runs); fixed at the cause. Gemini `extensions update` has no consent flag in 0.35.3, so it runs with stdin closed and returns the terminal command. Gemini reinstall undo needs `restore.acceptCommand` (moved into T3).
