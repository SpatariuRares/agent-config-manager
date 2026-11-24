# Claude Config Manager

One panel for the setup of your coding agents: Claude Code, Codex, Gemini CLI and Copilot CLI. Adding another agent is one provider folder: see [docs/adding-an-agent.md](docs/adding-an-agent.md).

See your whole Claude Code setup in one place: plugins, skills, agents, MCP servers and hooks.
Turn plugins on and off, move or copy items between global and projects, remove them, take and restore backups, and check for updates.

It runs as a small web app on `localhost` with nothing but Node, so it works next to any agent or
editor. The same panel also loads as an [Orca](https://github.com/stablyai/orca) sidebar plugin.

## Run it

Requires Node 23.6+ (it runs TypeScript directly) and the `claude` CLI on your PATH.

```sh
npm install
npm start                      # opens http://127.0.0.1:4321/#token=… in your browser
npm start -- --port 5000       # another port
npm start -- --no-open         # print the link instead of opening it
```

Keep the terminal open while you use the page; Ctrl-C stops it. The server listens on 127.0.0.1
only and prints a new secret link on every start: the page must be opened from that link, and
requests from other sites or host names are refused, so a web page you visit cannot change your
setup.

## How it is built

```
src/core/            Pure TypeScript, no Orca or HTTP: reads the setup into one model
  ports.ts           FileSystem: the only way the core touches the disk
  inventory.ts       readInventory(fs, paths) -> plugins, skills, agents, MCP, hooks
src/adapters/
  view.ts            The panel contract: view.get, action.run, updates.check
  backend.ts         buildView / runAction over the core
  node-fs.ts         FileSystem over node:fs, shared by every adapter
  http/              localhost server: serves panel/ and answers the contract as JSON
  orca/              Orca plugin worker answering the same contract
panel/               The HTML panel; transport.js picks localhost, Orca or a test fixture
```

The core never knows where it runs. Each target is an adapter around it.

## What it reads

| Section | Source |
| --- | --- |
| Plugins | `enabledPlugins` in `~/.claude/settings.json` |
| Skills | `~/.claude/skills/*/SKILL.md` (folders without one are skipped) |
| Agents | `~/.claude/agents/*.md` |
| MCP servers | `mcpServers` in `~/.claude.json` (user scope) |
| Hooks | `hooks` in `~/.claude/settings.json` |

A file that exists but cannot be parsed shows as a warning; the rest still loads.

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
