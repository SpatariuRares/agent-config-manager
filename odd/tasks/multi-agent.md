# Multi-agent: Claude Code, Codex, Gemini CLI, Copilot CLI

Objective: manage the setup of every main coding agent from the same panel, one agent at a time, through a provider per agent, so a new agent is one provider file plus its tests.
Branch: feat/multi-agent (stacked on feat/localhost) · Delivery: ask-on-risk · Tests: `npm test`, `npm run typecheck`, `npm run test:panel`.

## Specs

- S1 Agents: "io vorrei che possa gestire tutti i agenti principali quindi codex o simili". Providers for Claude Code (existing behavior, unchanged), Codex, Gemini CLI, Copilot CLI (the four installed here). Each reads the five classes it has (plugins/extensions, skills, agents, MCP servers, hooks) at user scope and, where the agent has them, per project.
- S2 Extensible: "e che sia facilemente estendibile a qls nuovo agente". An `AgentProvider` interface in src/providers; adding an agent = one provider module + its tests + one line in the registry; the panel and core need no change. A short docs/adding-an-agent.md explains it with the Copilot provider as the worked example.
- S3 One agent at a time (user picked option 1): an agent switcher at the top of the panel; tabs show only the classes that agent has; actions an agent does not support are hidden (read-only), with the agent's `note` saying why.
- S4 Writes per provider follow the existing safety rules: backup first, version check, refuse on concurrent change; prefer the agent's own CLI (`codex mcp add/remove`, `gemini mcp add/remove`, `gemini extensions enable/disable`, …) when it exists; TOML (Codex) only with format-preserving edits, otherwise read-only. Formats are taken from each agent's current docs or source, never from memory; anything unverified stays read-only and is listed.
- S5 Later (not this feature): copy an item from one agent to another.

## Contract

`src/adapters/view.ts` (this branch's first commit): `AgentInfo { id, name, detected, kinds, supports, configHome, note }`, `View.agents`, `View.agent`, `Item.agent`, `ActionRequest.agent`, and `AgentRequest { agent? }` as the input of 'view.get' and 'updates.check'.

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S2, S1 (Claude) | delegated writer A, parallel with T2: AgentProvider interface + registry, Claude provider from the existing core, backend/server/worker route by agent; every existing test stays green · Risk: item 3 (ports and contract reshaped) | done (177 tests; real Claude view unchanged) | b5e835a |
| T2 | S3 | delegated writer B, parallel with T1: panel agent switcher, capability-driven tabs and actions, fixture with 4 agents, Playwright | done (46 panel tests) | 075a9a0 |
| T3 | S1, S4 | delegated writers C, D, E in parallel after T1: Codex, Gemini, Copilot providers (research current formats first) · Risk: item 1 | running | |
| T4 | S2 | inline: docs/adding-an-agent.md, seam check, real read-only run, verifier on T3 writes | todo | |

## Log

- L1 (2026-11-24) User: "io vorrei che possa gestire tutti i agenti principali quindi codex o simili e che sia facilemente estendibile a qls nuovo agente"
- L2 User: "ok fallo" to: option 1 (one agent at a time with a switcher) and the provider interface now, copy between agents later.
- L3 Evidence: installed claude (/opt/homebrew/bin), codex-cli 0.171.0 (~/.local/bin), gemini 0.35.3 (nvm), Copilot CLI config in ~/.copilot. Codex: ~/.codex/config.toml with [marketplaces.*], [plugins."id@market"], [agents], [mcp_servers.*]; ~/.codex/skills, hooks.json, rules/, AGENTS.md. Gemini: ~/.gemini/settings.json (mcpServers, hooks), ~/.gemini/config/{agents,hooks.json,mcp_config.json,plugins}, extensions/, GEMINI.md. Copilot: ~/.copilot/mcp-config.json (mcpServers), agents/*.agent.md, skills/, installed-plugins/, config.json.
- L4 T1: AgentProvider { id, info, buildView, runAction, checkUpdates? } in src/providers/types.ts; router refuses unknown-agent / not-detected / unsupported before a provider runs; toolkit.ts + testing.ts (providerContract). Backups: Claude keeps ~/.claude/backups/claude-config-manager; new agents use ~/.config/claude-config-manager/backups/<agent>. Parent moved project-writes.test.ts into providers/claude and removed the two temporary core shims. Real Claude view through the provider: 33 plugins, 137 skills, 32 agents, 17 MCP, 53 hooks, 28 projects, 19 backups, no problems.
- L5 T2: switcher + capability-driven panel; open: the "Only me / Team" scope choice is still Claude's model; header still says "Claude Config".
- L6 Codex writes to config.toml only through `codex mcp add|remove` (smol-toml for reading only, it loses comments on write). Gemini has `gemini mcp add|remove|enable|disable` and `gemini extensions enable|disable [--scope]|uninstall|update`. Copilot: no `copilot` binary on PATH; `gh copilot` exists (preview).
