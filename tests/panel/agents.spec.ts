// The agent switcher and capability-driven UI (multi-agent S3) against the fixture backend (panel/fixture.js).
import { expect, test, type Page } from '@playwright/test'

const open = async (page: Page) => {
  await page.goto('index.html?fixture&latency=20')
  await expect(page.locator('.acc').first()).toBeVisible()
}
const tab = (page: Page, name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) })
const switcher = (page: Page) => page.getByRole('button', { name: /^Agent:/ })
const item = (page: Page, name: string) => page.locator('.item').filter({ has: page.locator('.name', { hasText: new RegExp(`^${name}$`) }) })

async function pickAgent(page: Page, name: string) {
  await switcher(page).click()
  await page.getByRole('menuitemradio', { name: new RegExp(`^${name}`) }).click()
  await expect(switcher(page)).toHaveAccessibleName(new RegExp(`^Agent: ${name}`))
  await expect(page.locator('.skeleton')).toHaveCount(0)
}

/** Everything the panel sent to the fixture backend, in order. */
const requests = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { ccmFixture: { requests: { name: string; input: any }[] } }).ccmFixture.requests)

test('the switcher lists the four agents and marks Copilot CLI as not installed', async ({ page }) => {
  await open(page)
  await expect(switcher(page)).toHaveText('Claude Code')
  await expect(page.locator('.agent-home')).toHaveText('~/.claude')
  await switcher(page).click()
  const options = page.getByRole('menuitemradio')
  await expect(options).toHaveCount(4)
  await expect(options.locator('.menu-label')).toHaveText(['Claude Code', 'Codex', 'Gemini CLI', 'Copilot CLI'])
  await expect(page.getByRole('menuitemradio', { name: /^Claude Code/ })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('menuitemradio', { name: /^Claude Code/ })).toBeFocused()
  const copilot = page.getByRole('menuitemradio', { name: /^Copilot CLI/ })
  await expect(copilot).toContainText('Not installed')
  await expect(copilot).toHaveClass(/is-dim/)
  await expect(copilot).not.toHaveAttribute('aria-disabled', 'true')
  for (const name of ['Claude Code', 'Codex', 'Gemini CLI']) {
    await expect(page.getByRole('menuitemradio', { name: new RegExp(`^${name}`) }), name).not.toContainText('Not installed')
  }

  // Still selectable: it shows where Copilot CLI would keep its setup.
  await copilot.click()
  await expect(switcher(page)).toHaveAccessibleName('Agent: Copilot CLI, not installed')
  await expect(page.locator('.agent .tag')).toHaveText('Not installed')
  await expect(page.locator('.agent-home')).toHaveText('~/.copilot')
  await expect(page.locator('.acc-empty')).toHaveText('Copilot CLI is not installed on this machine. Its plugins would live in ~/.copilot.')
})

test("switching loads that agent's items and tabs", async ({ page }) => {
  await open(page)
  await pickAgent(page, 'Codex')
  await expect(page.getByRole('tablist').getByRole('tab')).toHaveText(['Plugins2', 'Skills3', 'Agents2', 'MCP2', 'Hooks1'])
  await expect(page.locator('.item .name')).toHaveText(['github', 'linear'])
  await expect(page.locator('.agent-home')).toHaveText('~/.codex')
  await expect(page.locator('.agent-note')).toContainText('Plugins, agents and hooks are read-only')
  await expect(page.locator('#foot')).toHaveText('Changes apply to new Codex sessions.')

  await pickAgent(page, 'Gemini CLI')
  await expect(page.getByRole('tablist').getByRole('tab')).toHaveText(['Plugins3', 'MCP3'])
  await expect(page.locator('.item .name')).toHaveText(['code-review', 'conductor', 'security'])
  await expect(page.locator('.problems')).toHaveCount(0)

  await pickAgent(page, 'Claude Code')
  await expect(page.getByRole('tablist').getByRole('tab')).toHaveText(['Plugins22', 'Skills8', 'Agents4', 'MCP6', 'Hooks4'])
  await expect(page.locator('#foot')).toHaveText('Changes apply to new Claude Code sessions, or after /reload-plugins.')
})

test('the tab is kept when the new agent has that class, and the filter and update check are reset', async ({ page }) => {
  await open(page)
  await tab(page, 'MCP').click()
  await page.getByRole('textbox', { name: 'Filter by name' }).fill('context')
  await page.getByRole('button', { name: 'Check for updates' }).click()
  await expect(page.locator('.updates-status')).toContainText('Checked just now')

  await pickAgent(page, 'Gemini CLI')
  await expect(tab(page, 'MCP')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('textbox', { name: 'Filter by name' })).toHaveValue('')
  await expect(page.locator('.item .name')).toHaveText(['context7', 'github', 'playwright'])

  // Gemini CLI has no Skills: its first class shows, and Skills comes back with an agent that has it.
  await pickAgent(page, 'Claude Code')
  await expect(page.locator('.updates-status')).toHaveText('Updates not checked yet')
  await tab(page, 'Skills').click()
  await pickAgent(page, 'Gemini CLI')
  await expect(tab(page, 'Plugins')).toHaveAttribute('aria-selected', 'true')
  await pickAgent(page, 'Codex')
  await expect(tab(page, 'Skills')).toHaveAttribute('aria-selected', 'true')
})

test('actions the agent does not support are not offered', async ({ page }) => {
  await open(page)
  await pickAgent(page, 'Codex')
  // Plugins are read-only: no switch, no drag, no menu, no marketplace refresh; the state still shows.
  await expect(page.getByRole('switch')).toHaveCount(0)
  await expect(item(page, 'github').locator('.onoff')).toHaveText('On')
  await expect(item(page, 'linear').locator('.onoff')).toHaveText('Off')
  await expect(page.locator('.item[draggable="true"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Actions for/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Refresh marketplaces' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Check for updates' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Create backup' })).toBeVisible()

  // Skills are writable: drag, Move/Copy and Remove, but nothing to update.
  await tab(page, 'Skills').click()
  await expect(item(page, 'openai-docs')).toHaveAttribute('draggable', 'true')
  await item(page, 'openai-docs').getByRole('button', { name: 'Actions for openai-docs' }).click()
  await expect(page.getByRole('menuitem')).toHaveText(['Move to…', 'Copy to…', 'Remove'])
  await page.keyboard.press('Escape')

  // Agents and hooks are read-only.
  for (const name of ['Agents', 'Hooks']) {
    await tab(page, name).click()
    await expect(page.locator('.item[draggable="true"]'), name).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Actions for/ }), name).toHaveCount(0)
    await expect(page.locator('#tabpanel .grip.is-locked, #tabpanel .note'), name).toHaveCount(0)
  }

  // Gemini CLI: extensions only switch on and off; nothing to uninstall, move or update.
  await pickAgent(page, 'Gemini CLI')
  await expect(page.getByRole('switch')).toHaveCount(3)
  await expect(page.getByRole('button', { name: /^Actions for/ })).toHaveCount(0)
  await item(page, 'security').getByRole('switch').click()
  await expect(page.locator('#notice')).toContainText('Turned on security in Global.')

  // Copilot CLI is not installed: nothing to act on at all.
  await pickAgent(page, 'Copilot CLI')
  await expect(page.getByRole('button', { name: 'Create backup' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Check for updates' })).toHaveCount(0)
  await expect(page.locator('#backups')).toBeHidden()

  // Nothing the panel sent was refused.
  const actions = (await requests(page)).filter((r) => r.name === 'action.run')
  expect(actions.map((r) => r.input.action.type)).toEqual(['setEnabled'])
})

test('every request carries the selected agent', async ({ page }) => {
  await open(page)
  await pickAgent(page, 'Codex')
  await tab(page, 'MCP').click()
  await item(page, 'figma').getByRole('button', { name: 'Actions for figma' }).click()
  await page.getByRole('menuitem', { name: 'Remove' }).click()
  await expect(page.locator('#notice')).toContainText('Removed figma from Global.')
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.locator('.skeleton')).toHaveCount(0)
  await pickAgent(page, 'Claude Code')
  await page.getByRole('button', { name: 'Check for updates' }).click()
  await expect(page.locator('.updates-status')).toContainText('Checked just now')

  const sent = await requests(page)
  // The first read has no choice yet: the backend picks its first detected agent.
  expect(sent[0]).toEqual({ name: 'view.get', input: {} })
  expect(sent.slice(1).map((r) => [r.name, r.input.agent])).toEqual([
    ['view.get', 'codex'],
    ['action.run', 'codex'],
    ['view.get', 'codex'],
    ['view.get', 'claude'],
    ['updates.check', 'claude'],
  ])
  const run = sent.find((r) => r.name === 'action.run')!
  expect(Object.keys(run.input).sort()).toEqual(['action', 'agent', 'versions'])
  expect(Object.keys(run.input.versions)).toContain('/Users/you/.codex/config.toml')
})

test('the chosen agent is remembered across a reload', async ({ page }) => {
  await open(page)
  await pickAgent(page, 'Gemini CLI')
  await page.reload()
  await expect(switcher(page)).toHaveText('Gemini CLI')
  await expect(page.locator('.item .name')).toHaveText(['code-review', 'conductor', 'security'])
  expect((await requests(page))[0]).toEqual({ name: 'view.get', input: { agent: 'gemini' } })
})

test('a remembered agent the backend no longer knows is forgotten', async ({ page }) => {
  await page.goto('index.html?fixture&latency=0')
  await page.evaluate(() => localStorage.setItem('ccm.agent', 'retired-agent'))
  await page.reload()
  await expect(switcher(page)).toHaveText('Claude Code')
  await expect(page.locator('.acc').first()).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('ccm.agent'))).toBeNull()
})

test('no horizontal scroll at 320px, for every agent and the switcher menu', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 })
  await open(page)
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  for (const agent of ['Claude Code', 'Codex', 'Gemini CLI', 'Copilot CLI']) {
    await pickAgent(page, agent)
    for (const t of await page.getByRole('tablist').getByRole('tab').all()) {
      await t.click()
      expect(await overflow(), `${agent} ${await t.textContent()}`).toBeLessThanOrEqual(0)
    }
    await switcher(page).click()
    const menu = page.getByRole('menu', { name: 'Agents' })
    await expect(menu).toBeVisible()
    const box = (await menu.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width, agent).toBeLessThanOrEqual(320)
    expect(await overflow(), agent).toBeLessThanOrEqual(0)
    await page.keyboard.press('Escape')
    await expect(switcher(page)).toBeFocused()
  }
})
