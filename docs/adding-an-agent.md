# Adding an agent

Every coding agent this app manages is a **provider**: one folder under `src/providers/<id>/` that knows where the agent keeps its setup and how to change it safely. The panel, the localhost server, the Orca worker and the safety machinery (backups, version checks, trash, path guards) are shared, so a new agent needs no change outside its folder and one line in the registry.

The Copilot CLI provider (`src/providers/copilot/`) is the reference to copy: it is small and every file has one job.

```
src/providers/copilot/
  index.ts        info(), what it supports and why, sources of every fact
  paths.ts        where each class lives; which places belong to this agent
  read.ts         buildView(): files -> Items
  write.ts        runAction(): the writes it supports
  copilot.test.ts providerContract(...) plus one test per rule
```

## 1. Find out the facts first

Agents change their config formats often. Before writing code, establish each fact from a primary source (the agent's docs, its source code, `<agent> --help`) and list them in a comment block at the top of `index.ts`, one line per fact with its source. Read the user's real files only to confirm shapes, and never read auth files, tokens, chat history or logs.

For each of the five classes (`plugins`, `skills`, `agents`, `mcp`, `hooks`) answer:

- Where does the agent read it: user scope, per project, shared places other agents also read (`~/.agents/skills`, `.claude/`, `.mcp.json`)?
- Is there an official CLI command that changes it (`<agent> mcp add`, `<agent> extensions enable`)?
- If not, is the file format safe to rewrite (JSON with no comments) or not (TOML, JSON with comments)?

## 2. Implement `AgentProvider`

The interface is in `src/providers/types.ts`:

```ts
export interface AgentProvider {
  readonly id: AgentId
  info(deps: ProviderDeps): Promise<AgentInfo>
  buildView(deps: ProviderDeps): Promise<ProviderView>
  runAction(deps: ProviderDeps, request: ActionRequest): Promise<ActionResult>
  checkUpdates?(deps: ProviderDeps & { http: Http }): Promise<UpdatesAnswer>
  exportItem?(deps: ProviderDeps, key: string): Promise<Exported>
  importItem?(deps: ProviderDeps, item: Portable, to: Target, versions: Record<string, string>): Promise<ActionResult>
}
```

`deps` gives you the file system (`fs`), a command runner (`exec.run(binary, argv, cwd)`, `exec.find(name)`), the home folder, a clock and, for update checks only, the network. Never use `node:fs` or `child_process` directly: the fakes in tests and the real adapters both go through `deps`.

**`info()`** must be cheap: read files and call `exec.find` only, never run a command. Declare honestly:

- `kinds`: the classes the agent has (the panel shows only these tabs).
- `supports`: per class, the action types `runAction` really implements. The router refuses anything not listed before your code runs, and the panel hides it.
- `projectScopes`: per class, which project scopes a move or copy may target (`local` = only me, `project` = team), first one is the default. Leave a class out when items cannot go into a project. A class may be listed when `supports` has `move` for it, or when the agent `imports` it.
- `exports` and `imports`: the classes (`skills`, `mcp`) whose items can be copied to another agent, and taken from one, with the `copyToAgent` action. Leave them out (or empty) when the agent cannot; then say why in `note`.
- `note`: one sentence on what is read-only and why. Users read it.

**`buildView()`** returns items, the projects the agent knows, the version of every file it read (`versions`), backups and `problems`. Build keys with `itemKey(kind, ...)`: the router reads the class from the key. Never put secrets in an item (env values, headers, tokens in args or URLs): redact them with the toolkit's `redactArgs`, `redactUrl` and `redactCommand`, and never build a key from a secret.

**`runAction()`** implements what `supports` declares. Use the toolkit (`src/providers/toolkit.ts`) rather than writing files by hand:

| Need | Use |
| --- | --- |
| Change a JSON file safely (version check, backup first, 2-space format kept) | `editJsonFile` |
| Back up and restore files | `BackupStore` at `appBackupDir(home, '<id>')` |
| Move, copy or trash a skill folder or agent file | `moveEntry`, `trashEntry`, `restoreTrash` |
| Read `SKILL.md` and agent `.md` files | `readSkills`, `readAgents(fs, dir, '.agent.md')` |
| Refuse user values that look like CLI options | `optionLikeRefusal` |
| `copyToAgent`: build a Portable, refuse secrets, copy a skill | `portableMcp`, `exportSkill`, `secretRefusal`, `mcpJson`, `skillEntry` |
| Run the agent's CLI | `deps.exec.run(binary, argv, cwd)`: argv only, never a shell |

**`exportItem()` and `importItem()`** implement `copyToAgent` (copy an item to another agent), when `exports` and `imports` list a class. The router checks everything shared before either runs: both agents are detected, the source exports the class, the target imports it, and a project target uses one of the target's `projectScopes`. The answer's view is the source agent's, the message is prefixed with the target agent's name, and an `undo` from `importItem` is sent back with `undoAgent` set to the target, so the panel sends it there.

- `exportItem(deps, key)` reads the item and returns a `Portable` (`src/providers/types.ts`): an MCP server as `name`, `transport` (`stdio`, `http`, `sse`), `command`/`args` or `url`, `env` and `headers`; a skill as its `name` and folder. Map your config onto that shape with the toolkit's `portableMcp(name, fields, extra)`, passing in `extra` every setting the shape cannot carry: the copy is then refused with their names, never made without them. Use `exportSkill` for a skill folder. Exports only read, so read-only places can be exported.
- `importItem(deps, item, to, versions)` writes through your own write path and rules, as a move does: version check against `versions` (your view, read by the router just before), backup first, your agent's CLI when it has one, no writes to places other agents read, and the scopes you declared. Apply `secretRefusal(item, { commandLine, teamFile })` first: a CLI that takes the server on its command line must not get secret-looking args, url, env or header values, and a project file shared with the team gets only `${VAR}` references. Refuse with a clear message whatever your agent cannot represent (for example `codex mcp add` cannot carry env). Return an `undo` (usually a `remove` of the new item) when your agent supports removing it. Copy skill folders with `moveEntry(fs, places, skillEntry(item), project, true)`: it never overwrites and keeps a link as a link.

Rules every provider follows:

1. Prefer the agent's own CLI when it exists; it knows its format better than we do.
2. Back up every file a write (or the CLI) will change, before the change, and refuse when the file changed since the view was read (`CHANGED`).
3. Never rewrite a format you cannot preserve (TOML, JSON with comments): use the CLI, or leave it read-only and say so in `note`.
4. Never write places other agents also read, unless that is the point of the action and the user can see it.
5. Anything you could not verify stays read-only.

## 3. Test it

In your test file, call the contract suite once with a realistic fake home, then add one test per rule your provider has:

```ts
providerContract(myProvider(), {
  home: '/home',
  files: { '/home/.myagent/mcp.json': JSON.stringify({ mcpServers: { docs: { command: 'docs-mcp' } } }) },
  write: { action: (view) => ({ type: 'remove', key: view.items[0].key }), file: '/home/.myagent/mcp.json' }
})
```

The contract checks the info shape, cheap detection, keys and agent ids on items, that undeclared actions are refused, and that a write refuses a stale view and backs up first. Use `fakeFs` and `fakeExec` from `src/providers/testing.ts`: tests never touch the real home or run the real agent.

## 4. Register it

Add one line to `PROVIDERS` in `src/providers/registry.ts` (the order is the order of the agent switcher), and the agent's id to `src/providers/registry.test.ts`. Then:

```sh
npm test && npm run typecheck && npm run test:panel
npm start                      # the new agent appears in the switcher
```
