// Behaviour of the HTML panel against the in-memory fixture backend (panel/fixture.js).
import { expect, test, type Locator, type Page } from '@playwright/test'

const HOME = '/Users/you'
const STORE = `${HOME}/code/storefront`
const API = `${HOME}/code/api-gateway`
const NOTES = `${HOME}/code/notes`

const open = async (page: Page, query = '') => {
  await page.goto(`index.html?fixture&latency=20${query}`)
  await expect(page.locator('.acc').first()).toBeVisible()
}
const tab = (page: Page, name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) })
const group = (page: Page, project: string | null) => page.locator(`.acc[data-drop="${project ?? ''}"]`)
const item = (scope: Locator | Page, name: string) => {
  const page = 'page' in scope && typeof scope.page === 'function' ? scope.page() : (scope as Page)
  return scope.locator('.item').filter({ has: page.locator('.name', { hasText: new RegExp(`^${name}$`) }) })
}
const acmeReview = (page: Page) =>
  item(page, 'code-review').filter({ has: page.locator('.meta', { hasText: 'acme-tools' }) })
const groupTitles = (page: Page) => page.locator('.acc .acc-title').allTextContents()

/** A real HTML5 drag with the mouse; `target` is resolved after the drag starts (the strip appears then). */
async function drag(page: Page, source: Locator, target: () => Locator, { alt = false } = {}) {
  // Keep every accordion on screen: a drag cannot reach a target below the fold in a headless page.
  await page.setViewportSize({ width: 380, height: 1700 })
  const from = (await source.boundingBox())!
  await page.mouse.move(from.x + 24, from.y + 12)
  await page.mouse.down()
  if (alt) await page.keyboard.down('Alt')
  await page.mouse.move(from.x + 30, from.y + 24, { steps: 3 })
  await expect(page.locator('#dropstrip')).toBeVisible()
  // Let the strip finish sliding in before aiming at it.
  await page.locator('#dropstrip').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  const to = (await target().boundingBox())!
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(to.height / 2, 16), { steps: 6 })
  await page.mouse.up()
  if (alt) await page.keyboard.up('Alt')
  await expect(page.locator('#dropstrip')).toBeHidden()
}

test('tabs show every class with its count, and arrow keys move between them', async ({ page }) => {
  await open(page)
  const tabs = page.getByRole('tablist').getByRole('tab')
  await expect(tabs).toHaveText(['Plugins22', 'Skills8', 'Agents4', 'MCP6', 'Hooks4'])
  await expect(tab(page, 'Plugins')).toHaveAttribute('aria-selected', 'true')
  await tab(page, 'Plugins').focus()
  await page.keyboard.press('ArrowRight')
  await expect(tab(page, 'Skills')).toHaveAttribute('aria-selected', 'true')
  await expect(tab(page, 'Skills')).toBeFocused()
  await page.keyboard.press('End')
  await expect(tab(page, 'Hooks')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(tab(page, 'Plugins')).toHaveAttribute('aria-selected', 'true')
})

test('the filter applies to the active tab across all accordions, with an empty state', async ({ page }) => {
  await open(page)
  await page.getByRole('textbox', { name: 'Filter by name' }).fill('code-rev')
  await expect(page.locator('.item .name')).toHaveText(['code-review', 'code-review'])

  await tab(page, 'Skills').click()
  await page.getByRole('textbox', { name: 'Filter by name' }).fill('checkout')
  await expect(page.locator('.item .name')).toHaveText(['checkout-flows'])
  await expect(group(page, STORE)).toBeVisible()
  await expect(group(page, null)).toContainText('No match in Global.')

  await page.getByRole('textbox', { name: 'Filter by name' }).fill('zzz')
  await expect(page.getByText('No skills match “zzz”')).toBeVisible()
  await page.getByRole('button', { name: 'Clear filter' }).first().click()
  await expect(page.locator('.item')).toHaveCount(8)
})

test('each tab has Global plus one accordion per project that has items of that class', async ({ page }) => {
  await open(page)
  const expected: Record<string, string[]> = {
    Plugins: ['Global', 'api-gateway', 'storefront'],
    Skills: ['Global', 'storefront'],
    Agents: ['Global', 'api-gateway'],
    MCP: ['Global', 'api-gateway', 'storefront'],
    Hooks: ['Global', 'storefront'],
  }
  for (const [name, titles] of Object.entries(expected)) {
    await tab(page, name).click()
    await expect(page.locator('.acc .acc-title')).toHaveText(titles)
  }
  await expect(page.getByText(/Switches act on/i)).toHaveCount(0)

  // Open/closed state is remembered per tab.
  await tab(page, 'Hooks').click()
  await group(page, null).getByRole('button', { expanded: true }).click()
  await expect(item(page, 'Stop')).toBeHidden()
  await page.reload()
  await expect(tab(page, 'Hooks')).toHaveAttribute('aria-selected', 'true')
  await expect(group(page, null).locator('.acc-toggle')).toHaveAttribute('aria-expanded', 'false')
})

test('dragging an item moves it: it leaves its origin and appears in the target', async ({ page }) => {
  await open(page)
  await tab(page, 'Skills').click()
  await drag(page, item(group(page, null), 'pdf'), () => group(page, STORE))
  await expect(page.locator('#notice')).toContainText('Moved pdf to storefront.')
  await expect(item(group(page, null), 'pdf')).toHaveCount(0)
  await expect(item(group(page, STORE), 'pdf')).toHaveCount(1)
  await expect(tab(page, 'Skills')).toContainText('8')
})

test('holding ⌥ while dragging copies: the item stays in both places', async ({ page }) => {
  await open(page)
  await tab(page, 'Agents').click()
  await drag(page, item(group(page, null), 'test-runner'), () => group(page, API), { alt: true })
  await expect(page.locator('#notice')).toContainText('Copied test-runner to api-gateway.')
  await expect(item(group(page, null), 'test-runner')).toHaveCount(1)
  await expect(item(group(page, API), 'test-runner')).toHaveCount(1)
  await expect(tab(page, 'Agents')).toContainText('5')
})

test('the drop strip lists every project, so a project with no items can receive', async ({ page }) => {
  await open(page)
  await tab(page, 'Skills').click()
  await expect(group(page, NOTES)).toHaveCount(0)
  await drag(page, item(group(page, null), 'docx'), () => page.locator(`#dropstrip .chip[data-drop="${NOTES}"]`))
  await expect(page.locator('#notice')).toContainText('Moved docx to notes.')
  await expect(item(group(page, NOTES), 'docx')).toHaveCount(1)
  await expect(item(group(page, null), 'docx')).toHaveCount(0)
})

test('a drop into a project defaults to only me and offers to make it a team item', async ({ page }) => {
  await open(page)
  await tab(page, 'Hooks').click()
  await drag(page, item(group(page, null), 'Stop'), () => page.locator(`#dropstrip .chip[data-drop="${NOTES}"]`))
  const placed = item(group(page, NOTES), 'Stop')
  await expect(placed.locator('.tag')).toHaveText('Only me')
  await page.getByRole('button', { name: 'Make it a team item' }).click()
  await expect(placed.locator('.tag')).toHaveText('Team')
  await expect(page.locator('#notice')).toContainText('usually committed')
})

test('items that cannot move are not draggable and say why', async ({ page }) => {
  await open(page)
  await tab(page, 'Skills').click()
  const locked = item(page, 'changelog-writer')
  await expect(locked).toHaveAttribute('draggable', 'false')
  await expect(locked).toContainText('A symlink to ~/dotfiles/skills/changelog-writer')
  await locked.getByRole('button', { name: 'Actions for changelog-writer' }).click()
  await expect(page.getByRole('menuitem', { name: 'Move to…' })).toHaveAttribute('aria-disabled', 'true')
})

test('keyboard: "Move to…" opens a picker with Global and every project', async ({ page }) => {
  await open(page)
  await tab(page, 'MCP').click()
  await item(page, 'github').getByRole('button', { name: 'Actions for github' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitem', { name: 'Move to…' })).toBeFocused()
  await page.keyboard.press('Enter')
  const picker = page.getByRole('dialog', { name: 'Move github to' })
  await expect(picker.getByRole('option')).toHaveText([/Global/, /api-gateway/, /notes/, /storefront/])
  await expect(picker.getByRole('option', { name: /Global/ })).toHaveAttribute('aria-disabled', 'true')
  await expect(picker.getByRole('radio', { name: 'Only me' })).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('ArrowDown') // api-gateway -> notes
  await page.keyboard.press('Enter')
  await expect(page.locator('#notice')).toContainText('Moved github to notes.')
  await expect(item(group(page, NOTES), 'github').locator('.tag')).toHaveText('Only me')
  await expect(item(group(page, null), 'github')).toHaveCount(0)
  // Focus lands on the result so the keyboard user can undo.
  await expect(page.getByRole('button', { name: 'Undo' })).toBeFocused()
})

test('keyboard: "Copy to…" with Team scope', async ({ page }) => {
  await open(page)
  await tab(page, 'MCP').click()
  await item(page, 'sentry').getByRole('button', { name: 'Actions for sentry' }).click()
  await page.getByRole('menuitem', { name: 'Copy to…' }).click()
  const picker = page.getByRole('dialog', { name: 'Copy sentry to' })
  await picker.getByRole('radio', { name: 'Team' }).click()
  await picker.getByRole('option', { name: /storefront/ }).click()
  await expect(item(group(page, STORE), 'sentry').locator('.tag')).toHaveText('Team')
  await expect(item(group(page, null), 'sentry')).toHaveCount(1)
})

test('Undo after a move puts the item back', async ({ page }) => {
  await open(page)
  await tab(page, 'Skills').click()
  await drag(page, item(group(page, null), 'grilling'), () => group(page, STORE))
  await expect(item(group(page, STORE), 'grilling')).toHaveCount(1)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(item(group(page, null), 'grilling')).toHaveCount(1)
  await expect(item(group(page, STORE), 'grilling')).toHaveCount(0)
})

test('the plugin switch turns a plugin on and off, with undo', async ({ page }) => {
  await open(page)
  const feature = item(group(page, null), 'feature-dev')
  const toggle = feature.getByRole('switch')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(page.locator('#notice')).toContainText('Turned off feature-dev in Global.')
  await expect(toggle).toBeFocused()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
})

test('plugin rows show contents, the shared-name note and project Clear', async ({ page }) => {
  await open(page)
  const acme = acmeReview(page)
  await expect(acme).toContainText('Also installed from claude-plugins-official')
  const feature = item(group(page, null), 'feature-dev')
  await feature.getByRole('button', { name: 'Contents' }).click()
  await expect(feature.locator('.contents')).toContainText('code-architect, code-explorer, code-reviewer')
  const override = item(group(page, API), 'k8s-tools')
  await expect(override.locator('.tag')).toHaveText('Only me')
  await override.getByRole('button', { name: 'Clear' }).click()
  await expect(group(page, API)).toHaveCount(0)
  await expect(page.locator('#notice')).toContainText('follows Global again')
})

test('uninstall asks for an inline confirmation first', async ({ page }) => {
  await open(page)
  const acme = acmeReview(page)
  await acme.getByRole('button', { name: 'Actions for code-review' }).click()
  await page.getByRole('menuitem', { name: 'Uninstall…' }).click()
  const confirm = acme.getByRole('group', { name: /Confirm uninstall/ })
  await expect(confirm).toContainText('Uninstall code-review?')
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(acme).toHaveCount(1)

  await acme.getByRole('button', { name: 'Actions for code-review' }).click()
  await page.getByRole('menuitem', { name: 'Uninstall…' }).click()
  await acme.getByRole('button', { name: 'Uninstall', exact: true }).click()
  await expect(page.locator('#notice')).toContainText('Uninstalled code-review@acme-tools.')
  await expect(item(page, 'code-review')).toHaveCount(1)
  await expect(item(page, 'code-review')).not.toContainText('Also installed from')
})

test('Create backup adds entries, and Restore brings an earlier state back', async ({ page }) => {
  await open(page)
  const backups = page.locator('#backups')
  await expect(backups.locator('.acc-count')).toHaveText('3')
  await page.getByRole('button', { name: 'Create backup' }).click()
  await expect(page.locator('#notice')).toContainText(/Backed up \d+ settings files\./)
  const after = Number(await backups.locator('.acc-count').textContent())
  expect(after).toBeGreaterThan(3)
  await backups.getByRole('button', { name: 'Backups' }).click()
  await expect(backups.locator('.backup').first()).toContainText('just now')

  // Remove a skill, then restore the backup taken two hours ago (before it).
  await tab(page, 'Skills').click()
  await item(page, 'pdf').getByRole('button', { name: 'Actions for pdf' }).click()
  await page.getByRole('menuitem', { name: 'Remove' }).click()
  await expect(page.locator('#notice')).toContainText('Removed pdf from Global.')
  await expect(item(page, 'pdf')).toHaveCount(0)
  await backups.locator('.backup', { hasText: '2 h ago' }).getByRole('button', { name: 'Restore' }).click()
  await expect(page.locator('#notice')).toContainText('Restored settings.json')
  await expect(item(page, 'pdf')).toHaveCount(1)
})

test('states: load error with retry, and an empty setup', async ({ page }) => {
  await page.goto('index.html?fixture=error&latency=0')
  await expect(page.getByRole('alert')).toContainText('Could not read your Claude Code settings')
  await expect(page.getByRole('alert')).toContainText('Unexpected token')
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()

  await page.goto('index.html?fixture=empty&latency=0')
  await expect(tab(page, 'Plugins')).toContainText('0')
  await expect(page.locator('.acc .acc-title')).toHaveText(['Global'])
  await expect(page.getByText('No global plugins. Drag one here from a project')).toBeVisible()
})

test('loading shows a skeleton, and problems show as warnings', async ({ page }) => {
  await page.goto('index.html?fixture&latency=600')
  await expect(page.locator('.skeleton')).toBeVisible()
  await expect(page.locator('.acc').first()).toBeVisible()
  await page.getByText('1 problem in your settings').click()
  await expect(page.locator('.problems')).toContainText('agent-sdk-dev@old-market')
})

test('no horizontal page scroll at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 })
  await open(page)
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  for (const name of ['Plugins', 'Skills', 'Agents', 'MCP', 'Hooks']) {
    await tab(page, name).click()
    expect(await overflow(), name).toBeLessThanOrEqual(0)
  }
  await page.locator('.item').first().getByRole('button', { name: /^Actions for/ }).click()
  await page.getByRole('menuitem', { name: 'Move to…' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await overflow()).toBeLessThanOrEqual(0)
  await page.setViewportSize({ width: 800, height: 700 })
  expect(await overflow()).toBeLessThanOrEqual(0)
})

test('outside Orca, without the server link and without ?fixture, the panel says how to open it instead of showing sample data', async ({ page }) => {
  await page.goto('index.html')
  await expect(page.getByText(/link the server printed/i)).toBeVisible()
  // No sample data from the fixture backend.
  await expect(page.getByText('code-review')).toHaveCount(0)
})
