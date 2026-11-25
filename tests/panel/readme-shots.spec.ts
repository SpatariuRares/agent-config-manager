// The README screenshots, taken from the fixture (made-up paths and projects, never real data).
// Skipped in the normal run; regenerate with: README_SHOTS=1 npx playwright test readme-shots
import { expect, test, type Page } from '@playwright/test'

const dir = 'docs/screenshots'

test.skip(!process.env.README_SHOTS, 'set README_SHOTS=1 to regenerate docs/screenshots')
test.use({ deviceScaleFactor: 2 })

const open = async (page: Page, scheme: string, height: number) => {
  await page.setViewportSize({ width: 440, height })
  await page.goto(`index.html?fixture&latency=0&theme=${scheme}`)
  await expect(page.getByRole('tab', { name: /Plugins/ })).toContainText('22')
}

for (const scheme of ['dark', 'light'] as const) {
  test(`readme overview ${scheme}`, async ({ page }) => {
    await open(page, scheme, 900)
    await page.getByRole('button', { name: 'Check for updates' }).click()
    await expect(page.locator('.updates-status')).toContainText('Checked just now')
    await page.screenshot({ animations: 'disabled', path: `${dir}/overview-${scheme}.png` })
  })

  test(`readme agents ${scheme}`, async ({ page }) => {
    await open(page, scheme, 560)
    await page.getByRole('button', { name: /^Agent:/ }).click()
    await expect(page.getByRole('menuitemradio').first()).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: `${dir}/agents-${scheme}.png` })
  })

  test(`readme copy to agent ${scheme}`, async ({ page }) => {
    await open(page, scheme, 640)
    await page.getByRole('tab', { name: /^MCP/ }).click()
    await page.locator('.item', { hasText: 'github' }).first().getByRole('button', { name: /More actions|Actions/ }).click()
    await page.getByRole('menuitem', { name: 'Copy to agent…' }).click()
    await page.getByRole('menu', { name: 'Copy github to agent' }).getByRole('menuitem', { name: /^Gemini CLI/ }).click()
    await expect(page.getByRole('dialog', { name: 'Copy github to Gemini CLI' })).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: `${dir}/copy-to-agent-${scheme}.png` })
  })

  test(`readme drag ${scheme}`, async ({ page }) => {
    await open(page, scheme, 640)
    await page.getByRole('tab', { name: /Hooks/ }).click()
    const box = (await page.locator('.item').first().boundingBox())!
    await page.mouse.move(box.x + 20, box.y + 12)
    await page.mouse.down()
    await page.mouse.move(box.x + 30, box.y + 30, { steps: 3 })
    await page.locator('#dropstrip').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
    const chip = (await page.locator('#dropstrip .chip').nth(2).boundingBox())!
    await page.mouse.move(chip.x + 20, chip.y + 10, { steps: 4 })
    await page.screenshot({ path: `${dir}/drag-${scheme}.png` })
    await page.mouse.move(5, 5)
    await page.mouse.up()
  })
}
