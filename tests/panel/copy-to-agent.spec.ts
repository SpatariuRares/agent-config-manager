// Copy to agent (release-prep S3) against the fixture backend (panel/fixture.js): the item menu entry, the agent
// picker, the place picker with the target's scopes, the result notice and an Undo sent to the target agent.
import { expect, test, type Page } from '@playwright/test'

const open = async (page: Page) => {
  await page.goto('index.html?fixture&latency=20')
  await expect(page.locator('.acc').first()).toBeVisible()
}
const tab = (page: Page, name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) })
const item = (page: Page, name: string) => page.locator('.item').filter({ has: page.locator('.name', { hasText: new RegExp(`^${name}$`) }) })
const requests = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { ccmFixture: { requests: { name: string; input: any }[] } }).ccmFixture.requests)

test('Copy to agent… lists the detected agents that import the class, by keyboard, then the target places', async ({ page }) => {
  await open(page)
  await tab(page, 'MCP').click()
  const menuButton = item(page, 'github').getByRole('button', { name: /More actions|Actions/ })
  await menuButton.focus()
  await page.keyboard.press('Enter')
  const entry = page.getByRole('menuitem', { name: 'Copy to agent…' })
  await expect(entry).toBeVisible()
  await entry.focus()
  await page.keyboard.press('Enter')

  // Codex and Gemini CLI import MCP servers; Copilot CLI does too but is not installed, and Claude Code is the source.
  const agents = page.getByRole('menu', { name: 'Copy github to agent' }).getByRole('menuitem')
  await expect(agents.locator('.menu-label')).toHaveText(['Codex', 'Gemini CLI'])
  await expect(agents.first()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(agents.nth(1)).toBeFocused()
  await page.keyboard.press('Enter')

  // Gemini CLI takes MCP servers into a project as Team only: the picker says so and lists every project.
  const picker = page.getByRole('dialog', { name: 'Copy github to Gemini CLI' })
  await expect(picker).toBeVisible()
  await expect(picker.locator('.picker-note')).toHaveText('In a project, this class is always shared with the team.')
  await expect(picker.getByRole('option')).toHaveCount(4)
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  expect((await requests(page)).filter((r) => r.name === 'action.run')).toEqual([])
})

test('a copy to another agent shows the notice naming that agent, and Undo is sent to that agent', async ({ page }) => {
  await open(page)
  await tab(page, 'MCP').click()
  await item(page, 'github').getByRole('button', { name: /More actions|Actions/ }).click()
  await page.getByRole('menuitem', { name: 'Copy to agent…' }).click()
  await page.getByRole('menu', { name: 'Copy github to agent' }).getByRole('menuitem', { name: /^Codex/ }).click()

  const picker = page.getByRole('dialog', { name: 'Copy github to Codex' })
  await expect(picker.locator('.picker-note')).toHaveText('This class stays out of projects: it can only go to Global.')
  await picker.getByRole('option', { name: /^Global/ }).click()

  const notice = page.locator('#notice .notice')
  await expect(notice).toContainText('Codex: Copied github to Global.')
  const runs = (await requests(page)).filter((r) => r.name === 'action.run')
  expect(runs.at(-1)?.input).toMatchObject({ agent: 'claude', action: { type: 'copyToAgent', key: expect.any(String), toAgent: 'codex', to: { project: null } } })
  // The view stays on the source agent.
  await expect(page.getByRole('button', { name: /^Agent:/ })).toHaveText('Claude Code')

  await notice.getByRole('button', { name: 'Undo' }).click()
  await expect(page.locator('#notice .notice')).toContainText('Removed github')
  const undo = (await requests(page)).filter((r) => r.name === 'action.run').at(-1)
  expect(undo?.input).toMatchObject({ agent: 'codex', action: { type: 'remove' } })
  expect(Object.keys(undo?.input.versions ?? {}).length).toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: /^Agent:/ })).toHaveText('Claude Code')
  await expect(item(page, 'github')).toHaveCount(1)
})

test('an agent with no importer for the class has no Copy to agent entry', async ({ page }) => {
  await open(page)
  await tab(page, 'Hooks').click()
  await page.locator('.item').first().getByRole('button', { name: /More actions|Actions/ }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Copy to agent…' })).toHaveCount(0)
})
