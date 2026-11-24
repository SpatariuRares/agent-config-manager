import { defineConfig } from '@playwright/test'

const port = Number(process.env.PANEL_PORT ?? 4319)

export default defineConfig({
  testDir: 'tests/panel',
  outputDir: 'tests/panel/shots/results',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}/`,
    browserName: 'chromium',
    viewport: { width: 380, height: 760 },
  },
  webServer: {
    command: 'node tests/panel/serve.mjs',
    url: `http://127.0.0.1:${port}/index.html`,
    reuseExistingServer: !process.env.CI,
  },
})
