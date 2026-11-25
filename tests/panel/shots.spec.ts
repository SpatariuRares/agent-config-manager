// Screenshots of the fixture page for visual review (not assertions on pixels).
import { expect, test } from '@playwright/test'

const dir = 'tests/panel/shots'

for (const scheme of ['dark', 'light'] as const) {
  for (const width of [360, 480]) {
    test(`screenshot ${scheme} ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`index.html?fixture&latency=0&theme=${scheme}`)
      await expect(page.getByRole('tab', { name: /Plugins/ })).toContainText('22')
      await page.screenshot({ path: `${dir}/plugins-${scheme}-${width}.png`, fullPage: true })

      await page.getByRole('tab', { name: /Skills/ }).click()
      await page.getByRole('button', { name: 'Actions for tdd' }).click()
      await page.getByRole('menuitem', { name: 'Move to…' }).click()
      await page.keyboard.press('ArrowDown')
      await page.screenshot({ animations: 'disabled', path: `${dir}/skills-picker-${scheme}-${width}.png` })
      await page.keyboard.press('Escape')

      await page.getByRole('tab', { name: /MCP/ }).click()
      await page.getByRole('button', { name: 'Actions for context7' }).click()
      await page.getByRole('menuitem', { name: 'Remove' }).click()
      await expect(page.locator('#notice')).toContainText('Removed context7')
      await page.getByRole('button', { name: 'Backups' }).click()
      await page.screenshot({ animations: 'disabled', path: `${dir}/mcp-notice-${scheme}-${width}.png`, fullPage: true })
    })
  }
}

for (const scheme of ['dark', 'light'] as const) {
  test(`screenshot drag in progress ${scheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 760 })
    await page.goto(`index.html?fixture&latency=0&theme=${scheme}`)
    await page.getByRole('tab', { name: /Hooks/ }).click()
    const item = page.locator('.item').first()
    const box = (await item.boundingBox())!
    await page.mouse.move(box.x + 20, box.y + 12)
    await page.mouse.down()
    await page.mouse.move(box.x + 30, box.y + 30, { steps: 3 })
    await page.locator('#dropstrip').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
    const target = page.locator('.acc[data-group]').nth(1)
    const t = (await target.boundingBox())!
    await page.mouse.move(t.x + 60, t.y + 14, { steps: 4 })
    await page.screenshot({ path: `${dir}/drag-accordion-${scheme}-360.png` })
    await page.keyboard.down('Alt')
    const chip = page.locator('#dropstrip .chip').nth(2)
    const c = (await chip.boundingBox())!
    await page.mouse.move(c.x + 20, c.y + 10, { steps: 4 })
    await page.screenshot({ path: `${dir}/drag-strip-copy-${scheme}-360.png` })
    await page.keyboard.up('Alt')
    await page.mouse.move(5, 5)
    await page.mouse.up()
  })
}

for (const scheme of ['dark', 'light'] as const) {
  test(`screenshot updates ${scheme} 360px`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 })
    await page.goto(`index.html?fixture&latency=0&theme=${scheme}`)
    await expect(page.getByRole('tab', { name: /Plugins/ })).toContainText('22')
    await page.getByRole('button', { name: 'Check for updates' }).click()
    await expect(page.locator('.updates-status')).toContainText('Checked just now')
    await page.screenshot({ animations: 'disabled', path: `${dir}/updates-plugins-${scheme}-360.png` })

    await page.getByRole('tab', { name: /Skills/ }).click()
    await page.screenshot({ animations: 'disabled', path: `${dir}/updates-skills-${scheme}-360.png` })

    await page.getByRole('tab', { name: /MCP/ }).click()
    await page.screenshot({ animations: 'disabled', path: `${dir}/updates-mcp-${scheme}-360.png` })

    await page.getByRole('tab', { name: /Plugins/ }).click()
    await page.locator('.item', { hasText: 'deploy-helpers' }).getByRole('button', { name: 'Update' }).click()
    await expect(page.locator('pre.cmd')).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: `${dir}/updates-confirm-${scheme}-360.png` })

    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(page.locator('#notice')).toContainText('Updated deploy-helpers')
    await page.getByRole('tab', { name: /Skills/ }).click()
    await page.getByRole('button', { name: /^Update all/ }).click()
    await expect(page.locator('#notice')).toContainText('Updated 2 of 2 skills.')
    await page.screenshot({ animations: 'disabled', path: `${dir}/updates-all-notice-${scheme}-360.png` })
  })
}

for (const scheme of ['dark', 'light'] as const) {
  test(`screenshot agent switcher ${scheme} 360px`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 })
    await page.goto(`index.html?fixture&latency=0&theme=${scheme}`)
    await expect(page.getByRole('tab', { name: /Plugins/ })).toContainText('22')
    await page.getByRole('button', { name: /^Agent:/ }).click()
    await expect(page.getByRole('menu', { name: 'Agents' })).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: `${dir}/agents-menu-${scheme}-360.png` })

    await page.getByRole('menuitemradio', { name: /^Codex/ }).click()
    await expect(page.getByRole('tab', { name: /Plugins/ })).toContainText('2')
    await page.screenshot({ animations: 'disabled', path: `${dir}/agents-codex-${scheme}-360.png` })

    await page.getByRole('button', { name: /^Agent:/ }).click()
    await page.getByRole('menuitemradio', { name: /^Copilot CLI/ }).click()
    await expect(page.locator('.acc-empty').first()).toContainText('not installed')
    await page.screenshot({ animations: 'disabled', path: `${dir}/agents-copilot-${scheme}-360.png` })
  })
}
