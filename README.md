# Agent Config Manager

One panel for the setup of your coding agents: Claude Code, Codex, Gemini CLI and Copilot CLI. Adding another agent is one provider folder: see [docs/adding-an-agent.md](docs/adding-an-agent.md).

See plugins, skills, agents, MCP servers and hooks for each agent in one place. Turn them on and off, move or copy them between global and projects, remove them, take and restore backups, and check for updates, as far as each agent allows.

It runs as a small web app on `localhost` with nothing but Node, so it works next to any agent or
editor. The same panel also loads as an [Orca](https://github.com/stablyai/orca) sidebar plugin.

## Run it

Requires Node 23.6+ (it runs TypeScript directly) and the `claude` CLI on your PATH. It is not on
npm yet: install the `agent-config` command from a clone.

```sh
npm install
npm link                       # or: npm install -g .  (links the agent-config command to this clone)
agent-config                   # opens http://127.0.0.1:4321/#token=… in your browser
agent-config start --port 5000 # another port; --no-open prints the link instead
agent-config install-commands  # adds /agent-config to Claude Code, Codex, Gemini CLI and Copilot CLI
```

After `install-commands`, type `/agent-config` in Claude Code, Gemini CLI or Copilot CLI (in Codex:
`$agent-config`), and the agent starts the panel and gives you the link. `npm start` still works
from the clone. See [docs/launching.md](docs/launching.md) for every option and the exact files
written.

Keep the terminal open while you use the page; Ctrl-C stops it. The server listens on 127.0.0.1
only and prints a new secret link on every start: the page must be opened from that link, and
requests from other sites or host names are refused, so a web page you visit cannot change your
setup.

## How it is built

```
src/core/            Agent-neutral safety: versioned JSON writes, backups, trash, path guards,
                     CLI argv, secret redaction
src/providers/       One folder per agent (claude, codex, gemini, copilot) behind AgentProvider;
                     router.ts refuses anything an agent did not declare
src/adapters/
  view.ts            The panel contract: view.get, action.run, updates.check
  node-exec.ts       Runs agent CLIs by argv, never a shell, for every provider
  http/              localhost server: serves panel/ and answers the contract as JSON
  orca/              Orca plugin worker answering the same contract
src/cli/             The agent-config command
panel/               The HTML panel; transport.js picks localhost, Orca or a test fixture
```

## What it reads and changes

| Agent | Reads | Changes |
| --- | --- | --- |
| Claude Code | `~/.claude` (settings, skills, agents, plugins), `~/.claude.json`, project `.claude/` and `.mcp.json` | Plugins, skills, agents, MCP servers and hooks: on/off, move, copy, remove, update |
| Codex | `~/.codex` (`config.toml`, skills, agents, hooks), project `.codex/` and `.agents/` | MCP servers through `codex mcp`; skills and agent files. `config.toml` is never rewritten; plugins and hooks are read-only |
| Gemini CLI | `~/.gemini` (`settings.json`, extensions, skills, agents), project `.gemini/` | Extensions through `gemini extensions`, MCP servers through `gemini mcp`; skills, agents and hooks are read-only |
| Copilot CLI | `~/.copilot` (`mcp-config.json`, skills, agents, plugins, hooks), project `.github/` | MCP servers, skills and agents |

Folders several agents read (`~/.agents/skills`, a project's `.claude/` and `.mcp.json` for the other agents) are read-only. MCP servers and skills can be copied from one agent to another. Every change backs up the file first and is refused when the file changed since it was read. A file that exists but cannot be parsed shows as a warning; the rest still loads.

## Develop

Requires Node 23.6+ (runs TypeScript directly) and, for the plugin, Orca.

```sh
npm test                          # core, backend and server tests, node:test
npm run test:panel                # panel tests, Playwright on fixture data
npm run typecheck
orca plugin validate .            # manifest check
orca plugin check .               # renders the panel with your real setup
orca plugin dev load .            # load into Orca (asks for approval: it runs a Node worker)
```
