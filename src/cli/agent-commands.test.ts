import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { parse as parseToml } from 'smol-toml'
import { commandFiles, installCommands, MARKER, nodeInstallerFs, uninstallCommands } from './agent-commands.ts'

const scratch = await mkdtemp(join(tmpdir(), 'acm-cli-commands-'))
after(() => rm(scratch, { recursive: true, force: true }))

let count = 0
/** A fresh home with the config folders of the given agents. */
async function home(...agents: string[]) {
  const dir = join(scratch, `home-${++count}`)
  await mkdir(dir)
  for (const agent of agents) await mkdir(join(dir, `.${agent}`))
  return dir
}

const frontMatter = (text: string) => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  assert.ok(match, 'starts with YAML front matter')
  return Object.fromEntries(match[1].split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]))
}

const fileFor = (dir: string, agent: string) => {
  const file = commandFiles(dir).find((candidate) => candidate.agent === agent)
  assert.ok(file)
  return file
}

test('Claude Code gets a user skill at ~/.claude/skills/agent-config/SKILL.md, run only as /agent-config', async () => {
  const dir = await home('claude')
  const file = fileFor(dir, 'claude')
  assert.equal(file.path, join(dir, '.claude', 'skills', 'agent-config', 'SKILL.md'))
  const meta = frontMatter(file.content)
  assert.equal(meta.name, 'agent-config')
  assert.equal(meta['disable-model-invocation'], 'true')
  assert.ok(meta.description.length > 0)
  assert.match(file.content, /agent-config start/)
  assert.ok(file.content.includes(MARKER))
})

test('Codex gets a user skill at ~/.codex/skills/agent-config/SKILL.md with name and description', async () => {
  const dir = await home('codex')
  const file = fileFor(dir, 'codex')
  assert.equal(file.path, join(dir, '.codex', 'skills', 'agent-config', 'SKILL.md'))
  const meta = frontMatter(file.content)
  assert.equal(meta.name, 'agent-config')
  assert.ok(meta.description.length > 0)
  assert.match(file.content, /agent-config start/)
  assert.ok(file.content.includes(MARKER))
})

test('Gemini CLI gets a TOML command at ~/.gemini/commands/agent-config.toml with prompt and description', async () => {
  const dir = await home('gemini')
  const file = fileFor(dir, 'gemini')
  assert.equal(file.path, join(dir, '.gemini', 'commands', 'agent-config.toml'))
  const toml = parseToml(file.content) as { prompt: string; description: string }
  assert.deepEqual(Object.keys(toml).sort(), ['description', 'prompt'])
  assert.match(toml.prompt, /agent-config start/)
  assert.ok(toml.description.length > 0)
  assert.ok(file.content.startsWith(`# ${MARKER}`))
})

test('Copilot CLI gets a user skill at ~/.copilot/skills/agent-config/SKILL.md with name and description', async () => {
  const dir = await home('copilot')
  const file = fileFor(dir, 'copilot')
  assert.equal(file.path, join(dir, '.copilot', 'skills', 'agent-config', 'SKILL.md'))
  const meta = frontMatter(file.content)
  assert.equal(meta.name, 'agent-config')
  assert.ok(meta.description.length > 0)
  assert.match(file.content, /agent-config start/)
  assert.ok(file.content.includes(MARKER))
})

test('install writes one file per agent, with exactly the content of commandFiles', async () => {
  const dir = await home('claude', 'codex', 'gemini', 'copilot')
  const outcomes = await installCommands(nodeInstallerFs, dir, 'all', { dryRun: false })
  assert.deepEqual(outcomes.map((outcome) => [outcome.agent, outcome.status]), [
    ['claude', 'written'],
    ['codex', 'written'],
    ['gemini', 'written'],
    ['copilot', 'written']
  ])
  for (const file of commandFiles(dir)) assert.equal(await readFile(file.path, 'utf8'), file.content)
  assert.deepEqual(await readdir(join(dir, '.claude', 'skills')), ['agent-config'])
  assert.deepEqual(await readdir(join(dir, '.claude', 'skills', 'agent-config')), ['SKILL.md'])
})

test('install for all agents skips an agent whose config folder does not exist; --agent installs it anyway', async () => {
  const dir = await home('claude')
  const outcomes = await installCommands(nodeInstallerFs, dir, 'all', { dryRun: false })
  assert.deepEqual(outcomes.map((outcome) => [outcome.agent, outcome.status]), [
    ['claude', 'written'],
    ['codex', 'skipped'],
    ['gemini', 'skipped'],
    ['copilot', 'skipped']
  ])
  assert.deepEqual((await readdir(dir)).sort(), ['.claude'])
  const [gemini] = await installCommands(nodeInstallerFs, dir, ['gemini'], { dryRun: false })
  assert.equal(gemini.status, 'written')
  assert.equal(await readFile(fileFor(dir, 'gemini').path, 'utf8'), fileFor(dir, 'gemini').content)
})

test('install refuses to overwrite a file it did not create, and leaves it unchanged', async () => {
  const dir = await home('claude')
  const path = fileFor(dir, 'claude').path
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, '---\nname: agent-config\ndescription: mine\n---\nMy own skill.\n')
  const [outcome] = await installCommands(nodeInstallerFs, dir, ['claude'], { dryRun: false })
  assert.equal(outcome.status, 'refused')
  assert.match(outcome.reason ?? '', /not created by agent-config/)
  assert.equal(await readFile(path, 'utf8'), '---\nname: agent-config\ndescription: mine\n---\nMy own skill.\n')
})

test('install again leaves its own file alone when unchanged and replaces it when outdated', async () => {
  const dir = await home('gemini')
  const file = fileFor(dir, 'gemini')
  await installCommands(nodeInstallerFs, dir, ['gemini'], { dryRun: false })
  assert.equal((await installCommands(nodeInstallerFs, dir, ['gemini'], { dryRun: false }))[0].status, 'unchanged')
  await writeFile(file.path, `# ${MARKER}\nprompt = "old"\n`)
  assert.equal((await installCommands(nodeInstallerFs, dir, ['gemini'], { dryRun: false }))[0].status, 'updated')
  assert.equal(await readFile(file.path, 'utf8'), file.content)
})

test('uninstall removes only its own files (and the empty skill folder), never a foreign one', async () => {
  const dir = await home('claude', 'codex', 'gemini', 'copilot')
  await installCommands(nodeInstallerFs, dir, 'all', { dryRun: false })
  const foreign = fileFor(dir, 'codex').path
  await writeFile(foreign, '---\nname: agent-config\ndescription: mine\n---\n')
  const outcomes = await uninstallCommands(nodeInstallerFs, dir, 'all', { dryRun: false })
  assert.deepEqual(outcomes.map((outcome) => [outcome.agent, outcome.status]), [
    ['claude', 'removed'],
    ['codex', 'refused'],
    ['gemini', 'removed'],
    ['copilot', 'removed']
  ])
  assert.deepEqual(await readdir(join(dir, '.claude', 'skills')), [])
  assert.deepEqual(await readdir(join(dir, '.gemini', 'commands')), [])
  assert.equal(await readFile(foreign, 'utf8'), '---\nname: agent-config\ndescription: mine\n---\n')
  assert.equal((await uninstallCommands(nodeInstallerFs, dir, ['gemini'], { dryRun: false }))[0].status, 'absent')
})

test('uninstall keeps a skill folder that holds other files', async () => {
  const dir = await home('claude')
  await installCommands(nodeInstallerFs, dir, ['claude'], { dryRun: false })
  const folder = join(fileFor(dir, 'claude').path, '..')
  await writeFile(join(folder, 'notes.md'), 'mine')
  assert.equal((await uninstallCommands(nodeInstallerFs, dir, ['claude'], { dryRun: false }))[0].status, 'removed')
  assert.deepEqual(await readdir(folder), ['notes.md'])
})

test('dry-run lists what would be written or removed and writes nothing', async () => {
  const dir = await home('claude', 'gemini')
  const before = await readdir(dir, { recursive: true })
  const install = await installCommands(nodeInstallerFs, dir, 'all', { dryRun: true })
  assert.deepEqual(install.map((outcome) => [outcome.agent, outcome.status, outcome.path]), [
    ['claude', 'would-write', fileFor(dir, 'claude').path],
    ['codex', 'skipped', fileFor(dir, 'codex').path],
    ['gemini', 'would-write', fileFor(dir, 'gemini').path],
    ['copilot', 'skipped', fileFor(dir, 'copilot').path]
  ])
  assert.deepEqual(await readdir(dir, { recursive: true }), before)

  await installCommands(nodeInstallerFs, dir, 'all', { dryRun: false })
  const installed = await readdir(dir, { recursive: true })
  const uninstall = await uninstallCommands(nodeInstallerFs, dir, 'all', { dryRun: true })
  assert.deepEqual(uninstall.filter((outcome) => outcome.status === 'would-remove').map((outcome) => outcome.agent), ['claude', 'gemini'])
  assert.deepEqual(await readdir(dir, { recursive: true }), installed)
})
