# Claude Config Manager

See your whole Claude Code setup in one place: plugins, skills, agents, MCP servers and hooks.
Today it is read-only; enabling and disabling (with automatic backups) comes next.

It ships first as an [Orca](https://github.com/stablyai/orca) sidebar plugin, and later as a
small web app on `localhost` for Claude Code without Orca.

## How it is built

```
src/core/            Pure TypeScript, no Orca or HTTP: reads the setup into one model
  ports.ts           FileSystem: the only way the core touches the disk
  inventory.ts       readInventory(fs, paths) -> plugins, skills, agents, MCP, hooks
src/adapters/
  node-fs.ts         FileSystem over node:fs, shared by every adapter
  orca/              Orca plugin: worker (disk access) + components panel (UI)
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
npm test                          # core tests, node:test
orca plugin validate .            # manifest check
orca plugin check .               # renders the panel with your real setup
orca plugin dev load .            # load into Orca (asks for approval: it runs a Node worker)
```
