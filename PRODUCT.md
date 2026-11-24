# Claude Config Manager

## Product

A local tool for one developer to see and manage their whole Claude Code setup: plugins, skills, agents, MCP servers and hooks, at user (global) scope and per project.

## Users and job

- Primary user: a developer who runs Claude Code daily with many plugins, skills, agents, MCP servers and hooks, and loses track of what is installed where and what is active.
- Job: see everything in one place, turn things on and off, move or copy an item between global and a project, remove what is no longer needed, and take or restore backups, without hand-editing JSON.
- Usage scene: a sidebar panel next to an open workspace in Orca, glanced at and acted on between coding tasks; later the same UI on localhost for Claude Code without Orca.

## Product truth

- Sources: `~/.claude/settings.json`, `~/.claude.json`, `~/.claude/skills|agents`, `~/.claude/plugins/installed_plugins.json`, and per project `.claude/settings.json`, `.claude/settings.local.json`, `.claude/skills|agents`, `.mcp.json`.
- Precedence for a project: local > project > user.
- Every write backs up the file first and refuses when the file changed since it was read. Operations Claude Code owns (plugin uninstall, MCP add/remove) go through the official `claude` CLI.
- Changes apply to new Claude Code sessions, or after `/reload-plugins`.

## Platform

web (an HTML panel inside the Orca desktop app; the same page on localhost later). Theming comes from Orca's `--orca-*` variables, light and dark.

## Stack

Orca plugin: trusted Node worker (TypeScript, no build step) plus an HTML panel. Chosen by the user over Orca components because components cannot do drag and drop.

## Inferred (not yet confirmed)

- Single user; no accounts, no network.
