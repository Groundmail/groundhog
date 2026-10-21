import { defineConfig, devices } from '@playwright/test'

// Runs the Playwright example (examples/playwright) and the UI tests (e2e) against the built CLI.
const HTTP = 3035
const SMTP = 1035

export default defineConfig({
  testDir: '.',
  testMatch: ['examples/playwright/**/*.spec.ts', 'e2e/**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  webServer: [
    {
      command: `node dist/cli.js --no-open --quiet --http-port ${HTTP} --smtp-port ${SMTP}`,
      url: `http://localhost:${HTTP}/api/health`,
      reuseExistingServer: false,
    },
    {
      command: 'node examples/playwright/app.mjs',
      url: 'http://localhost:3999/',
      env: { SMTP_PORT: String(SMTP), APP_PORT: '3999' },
      reuseExistingServer: false,
    },
  ],
})

process.env.GROUNDHOG_URL = `http://localhost:${HTTP}`
