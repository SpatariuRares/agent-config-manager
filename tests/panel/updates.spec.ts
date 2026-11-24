// Updates in the HTML panel (S1–S4) against the in-memory fixture backend (panel/fixture.js).
import { expect, test, type Locator, type Page } from '@playwright/test'

const HOME = '/Users/you'
const API = `${HOME}/code/api-gateway`
const USER_SETTINGS = `${HOME}/.claude/settings.json`
const pluginKey = (id: string) => `plugins:${USER_SETTINGS}#~#${id}`
const skillKey = (name: string) => `skills:${HOME}/.claude/skills/${name}/SKILL.md`
const APPROVAL_SHA = '5f0c2e8a9b41d736e0a2c95f18b7d4e3a6c09f2b8e51d7a4c3b60e9f2d18a7c5'

const open = async (page: Page) => {
  await page.goto('index.html?fixture&latency=20')
  await expect(page.locator('.acc').first()).toBeVisible()
}
const tab = (page: Page, name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) })
const group = (page: Page, project: string | null) => page.locator(`.acc[data-drop="${project ?? ''}"]`)
const item = (scope: Locator | Page, name: string, market?: string) => {
  const page = 'page' in scope && typeof scope.page === 'function' ? scope.page() : (scope as Page)
  const found = scope.locator('.item').filter({ has: page.locator('.name', { hasText: new RegExp(`^${name}$`) }) })
  return market ? found.filter({ has: page.locator('.meta', { hasText: market }) }) : found
}
const checkForUpdates = async (page: Page) => {
  await page.getByRole('button', { name: 'Check for updates' }).click()
  await expect(page.locator('.updates-status')).toContainText('Checked just now')
}

/** Everything the panel sent to the fixture backend, in order. */
const requests = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { ccmFixture: { requests: { name: string; input: any }[] } }).ccmFixture.requests)
const actionsSent = async (page: Page) => (await requests(page)).filter((r) => r.name === 'action.run').map((r) => r.input.action)

test('source badges show where each item updates from; local items show none', async ({ page }) => {
  await open(page)
  const feature = item(group(page, null), 'feature-dev')
  await expect(feature.locator('.src-type')).toHaveText('marketplace')
  await expect(feature.locator('.src-label')).toHaveText('claude-plugins-official')
  await expect(feature.locator('.src .ver')).toHaveText('1.6.0')
  await expect(item(page, 'tmux-pilot').locator('.src-label')).toHaveText('community-hub')
  await expect(item(group(page, API), 'k8s-tools').locator('.src-row')).toHaveCount(0)

  await tab(page, 'Skills').click()
  await expect(item(page, 'tdd').locator('.src')).toHaveText(/skills.*mattpocock\/skills/)
  await expect(item(page, 'gsap-scrolltrigger').locator('.src-label')).toHaveText('greensock/gsap-skills')
  for (const local of ['changelog-writer', 'design-tokens', 'checkout-flows']) {
    await expect(item(page, local).locator('.src-row'), local).toHaveCount(0)
  }

  await tab(page, 'MCP').click()
  await expect(item(page, 'context7').locator('.src')).toHaveText(/npm.*@upstash\/context7-mcp.*2\.2\.5/)
  await expect(item(page, 'engram').locator('.src')).toHaveText(/Homebrew.*brew upgrade engram/)
  await expect(item(page, 'github').locator('.src-row')).toHaveCount(0)
  await expect(item(page, 'sentry').locator('.src-row')).toHaveCount(0)

  for (const name of ['Agents', 'Hooks']) {
    await tab(page, name).click()
    await expect(page.locator('.src-row'), name).toHaveCount(0)
  }
})

test('Check for updates runs only on demand and fills item statuses and tab counts', async ({ page }) => {
  await open(page)
  await expect(page.locator('.updates-status')).toHaveText('Updates not checked yet')
  await page.waitForTimeout(400)
  expect((await requests(page)).filter((r) => r.name === 'updates.check')).toHaveLength(0)
  await expect(page.locator('.upd')).toHaveCount(0)

  await page.getByRole('button', { name: 'Check for updates' }).click()
  await expect(page.locator('.updates-status')).toContainText('Checking for updates…')
  await expect(page.locator('.upd.is-checking').first()).toBeVisible()
  await expect(page.locator('.updates-status')).toContainText('Checked just now')
  await expect(page.locator('.upd.is-checking')).toHaveCount(0)
  expect((await requests(page)).filter((r) => r.name === 'updates.check')).toHaveLength(1)

  await expect(tab(page, 'Plugins').locator('.tab-updates')).toHaveText('4')
  await expect(tab(page, 'Skills').locator('.tab-updates')).toHaveText('2')
  await expect(tab(page, 'MCP').locator('.tab-updates')).toHaveText('1')
  await expect(tab(page, 'Agents').locator('.tab-updates')).toHaveCount(0)
  await expect(tab(page, 'Hooks').locator('.tab-updates')).toHaveCount(0)

  await expect(item(group(page, null), 'feature-dev').getByRole('button', { name: 'Update' })).toHaveText(/Update\s*1\.7\.0/)
  await expect(item(page, 'code-review', 'claude-plugins-official').locator('.upd')).toHaveText('Up to date')
  const unknown = item(page, 'hookify').locator('.upd')
  await expect(unknown).toContainText('Unknown')
  await expect(unknown).toHaveAttribute('title', /does not declare a version/)
  await expect(page.locator('.tab-tools').getByRole('button', { name: 'Update all (4)' })).toBeVisible()

  // A manual source never gets an Update button; local items get no status.
  await tab(page, 'MCP').click()
  await expect(item(page, 'engram').getByRole('button')).toHaveCount(1) // only the actions menu
  await expect(item(page, 'github').locator('.upd')).toHaveCount(0)
})

test('Update on one item updates it, reports the outcome and drops its status', async ({ page }) => {
  await open(page)
  await checkForUpdates(page)
  const feature = item(group(page, null), 'feature-dev')
  await feature.getByRole('button', { name: 'Update' }).click()
  await expect(page.locator('#notice')).toContainText('Updated feature-dev 1.6.0 → 1.7.0. Restart Claude Code to load the new version.')
  await expect(feature.locator('.src .ver')).toHaveText('1.7.0')
  await expect(feature.locator('.upd, .upd-btn')).toHaveCount(0)
  await expect(tab(page, 'Plugins').locator('.tab-updates')).toHaveText('3')
  // Other statuses from the same check are kept.
  await expect(item(page, 'tmux-pilot').getByRole('button', { name: 'Update' })).toBeVisible()
  expect(await actionsSent(page)).toEqual([{ type: 'update', key: pluginKey('feature-dev@claude-plugins-official') }])

  // The overflow menu offers Update for any item with a source, and none for local ones.
  await tab(page, 'MCP').click()
  await item(page, 'context7').getByRole('button', { name: 'Actions for context7' }).click()
  await page.getByRole('menuitem', { name: 'Update to 2.3.1' }).click()
  await expect(page.locator('#notice')).toContainText('Updated context7 to @upstash/context7-mcp 2.3.1')
  await expect(item(page, 'context7').locator('.mono-line')).toHaveText('npx -y --package=@upstash/context7-mcp@2.3.1 -- context7-mcp')
  await item(page, 'engram').getByRole('button', { name: 'Actions for engram' }).click()
  await expect(page.getByRole('menuitem', { name: 'Update' })).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await item(page, 'github').getByRole('button', { name: 'Actions for github' }).click()
  await expect(page.getByRole('menuitem', { name: /^Update/ })).toHaveCount(0)
})

test('Update all sends the available keys of the tab and reports each outcome', async ({ page }) => {
  await open(page)
  await checkForUpdates(page)
  await tab(page, 'Skills').click()
  await page.getByRole('button', { name: 'Update all (2)' }).click()
  const notice = page.locator('#notice')
  await expect(notice).toContainText('Updated 2 of 2 skills.')
  await expect(notice).toContainText('Updated tdd from mattpocock/skills')
  await expect(notice).toContainText('Updated grilling from mattpocock/skills')
  expect(await actionsSent(page)).toEqual([{ type: 'updateAll', kind: 'skills', keys: [skillKey('tdd'), skillKey('grilling')] }])
  await expect(tab(page, 'Skills').locator('.tab-updates')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Update all/ })).toHaveCount(0)
  await expect(item(page, 'tdd').locator('.upd, .upd-btn')).toHaveCount(0)
  await expect(item(page, 'pdf').locator('.upd')).toHaveText('Up to date')

  // Plugins: the one that needs a command approved is skipped and said so; the rest restart-note.
  await tab(page, 'Plugins').click()
  await page.getByRole('button', { name: 'Update all (4)' }).click()
  await expect(notice).toContainText('Updated 3 of 4 plugins.')
  await expect(notice).toContainText('Restart Claude Code to load the new versions.')
  await expect(notice).toContainText('deploy-helpers was not updated')
  await expect(tab(page, 'Plugins').locator('.tab-updates')).toHaveText('1')
  await expect(item(page, 'deploy-helpers').getByRole('button', { name: 'Update' })).toBeVisible()
})

test('a plugin that needs a command approved shows it and sends nothing until Run update', async ({ page }) => {
  await open(page)
  await checkForUpdates(page)
  const deploy = item(page, 'deploy-helpers')
  await deploy.getByRole('button', { name: 'Update' }).click()
  const confirm = deploy.getByRole('group', { name: 'Approve the command for deploy-helpers' })
  await expect(confirm).toContainText('Update deploy-helpers?')
  await expect(confirm.locator('pre.cmd')).toContainText('postinstall.sh | sh -s -- --install-dir')
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await expect(page.locator('#notice')).toBeEmpty()

  await page.waitForTimeout(400)
  expect(await actionsSent(page)).toEqual([{ type: 'update', key: pluginKey('deploy-helpers@acme-tools') }])
  await expect(deploy.locator('.src .ver')).toHaveText('3.1.0')

  await confirm.getByRole('button', { name: 'Run update' }).click()
  await expect(page.locator('#notice')).toContainText('Updated deploy-helpers 3.1.0 → 3.2.0')
  await expect(confirm).toHaveCount(0)
  await expect(deploy.locator('.src .ver')).toHaveText('3.2.0')
  const sent = await actionsSent(page)
  expect(sent).toHaveLength(2)
  expect(sent[1]).toEqual({ type: 'update', key: pluginKey('deploy-helpers@acme-tools'), acceptCommand: APPROVAL_SHA })
})

test('Cancel on the approval sends nothing', async ({ page }) => {
  await open(page)
  await checkForUpdates(page)
  const deploy = item(page, 'deploy-helpers')
  await deploy.getByRole('button', { name: 'Update' }).click()
  const confirm = deploy.getByRole('group', { name: /Approve the command/ })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(deploy.getByRole('button', { name: 'Actions for deploy-helpers' })).toBeFocused()
  await page.waitForTimeout(400)
  expect(await actionsSent(page)).toEqual([{ type: 'update', key: pluginKey('deploy-helpers@acme-tools') }])
  await expect(deploy.locator('.src .ver')).toHaveText('3.1.0')
  await expect(deploy.getByRole('button', { name: 'Update' })).toBeVisible()
})

test('Refresh marketplaces runs from the Plugins tab', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Refresh marketplaces' }).click()
  await expect(page.locator('#notice')).toContainText('Refreshed 3 marketplaces: claude-plugins-official, acme-tools, community-hub.')
  expect(await actionsSent(page)).toEqual([{ type: 'refreshMarketplaces' }])
  await tab(page, 'Skills').click()
  await expect(page.getByRole('button', { name: 'Refresh marketplaces' })).toHaveCount(0)
})

test('sources the check could not reach show once as a warning line', async ({ page }) => {
  await open(page)
  await checkForUpdates(page)
  const warning = page.locator('.updates-errors summary')
  await expect(warning).toHaveCount(1)
  await expect(warning).toHaveText('1 source could not be checked')
  await warning.click()
  const errors = page.locator('.updates-error')
  await expect(errors).toHaveCount(1)
  await expect(errors).toBeVisible()
  await expect(errors).toHaveText('greensock/gsap-skills: GitHub rate limit reached (60 requests per hour); try again in 41 min.')
  await tab(page, 'Skills').click()
  await expect(page.getByText(/GitHub rate limit reached \(60/)).toHaveCount(1)
  await expect(item(page, 'gsap-scrolltrigger').locator('.upd')).toContainText('Unknown')
})

test('no horizontal scroll at 320px with update buttons and the approval visible', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 })
  await open(page)
  await checkForUpdates(page)
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  for (const name of ['Plugins', 'Skills', 'Agents', 'MCP', 'Hooks']) {
    await tab(page, name).click()
    expect(await overflow(), name).toBeLessThanOrEqual(0)
  }
  await tab(page, 'Plugins').click()
  const update = item(group(page, null), 'feature-dev').getByRole('button', { name: 'Update' })
  await expect(update).toBeVisible()
  const box = (await update.boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(320)
  await item(page, 'deploy-helpers').getByRole('button', { name: 'Update' }).click()
  await expect(page.locator('pre.cmd')).toBeVisible()
  expect(await overflow()).toBeLessThanOrEqual(0)
})
