import { expect, test } from '@playwright/test'

const UI = process.env.GROUNDHOG_URL ?? 'http://localhost:3035'

test.beforeEach(async ({ request }) => {
  await request.delete(`${UI}/api/emails`)
  await request.delete(`${UI}/api/faults`)
})

test('first run shows the burrow and the setup snippets', async ({ page }) => {
  await page.goto(UI)
  await expect(page.getByRole('heading', { name: 'Nothing in the burrow yet' })).toBeVisible()
  await page.getByRole('tab', { name: 'Postmark' }).click()
  await expect(page.locator('.connect-body pre')).toContainText('/postmark')
  await expect(page.getByRole('link', { name: 'Groundmail' }).first()).toHaveAttribute('href', /utm_source=groundhog/)
})

test('a caught email shows up live, renders in the sandboxed frame, and has its code', async ({ page, request }) => {
  await page.goto(UI)
  await request.post(`${UI}/api/emails/sample`)
  await expect(page.getByText('Caught one')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Your Acme sign-in code' })).toBeVisible()
  const code = (await page.locator('.chip.code strong').textContent())!
  expect(code).toMatch(/^\d{6}$/)
  const frame = page.frameLocator('iframe[title="Email preview"]')
  await expect(frame.getByText(code)).toBeVisible()
  await page.getByRole('button', { name: 'Mobile' }).click()
  await expect(page.locator('.frame-wrap')).toHaveClass(/mobile/)
  await page.getByRole('button', { name: 'Dark' }).click()
  await expect(page.locator('.frame-wrap')).toHaveClass(/dark/)
  await page.getByRole('tab', { name: 'Source' }).click()
  await expect(page.locator('pre.raw')).toContainText('Subject: Your Acme sign-in code')
  await page.getByRole('tab', { name: 'Headers' }).click()
  await expect(page.locator('table.headers')).toContainText('Message-ID')
  await page.getByPlaceholder('Search to, subject, text').fill('nothing-matches')
  await expect(page.getByText('0 of 1 match')).toBeVisible()
})

test('the email HTML cannot run scripts', async ({ page, request }) => {
  const evil = await request.post(`${UI}/groundmail/emails`, {
    data: { from: 'a@acme.test', to: 'x@example.com', subject: 'XSS', html: '<p id="p">hi</p><script>parent.document.title="pwned"</script><img src=x onerror="parent.document.title=\'pwned\'">' },
  })
  expect(evil.ok()).toBe(true)
  await page.goto(UI)
  await expect(page.frameLocator('iframe[title="Email preview"]').getByText('hi')).toBeVisible()
  await page.waitForTimeout(300)
  expect(await page.title()).toBe('Groundhog')
})

test('failure mode banner and Go live dialog', async ({ page, request }) => {
  await request.post(`${UI}/api/emails/sample`)
  await page.goto(UI)
  await page.getByRole('button', { name: 'Failure mode' }).click()
  await page.getByRole('radio', { name: /Provider outage/ }).click()
  await page.getByRole('button', { name: 'Turn on failure mode' }).click()
  await expect(page.getByText(/Failure mode on: the next 3 sends return/)).toBeVisible()
  await request.post(`${UI}/groundmail/emails`, { data: { from: 'a@acme.test', to: 'x@example.com', subject: 'x', text: 'x' } })
  await expect(page.getByText(/the next 2 sends return/)).toBeVisible()
  await page.getByRole('button', { name: 'Turn off' }).click()
  await expect(page.locator('#fault-banner')).toBeHidden()

  await page.getByRole('button', { name: 'Go live on Groundmail' }).click()
  await expect(page.getByRole('heading', { name: 'Ready for real inboxes?' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Start free on Groundmail' })).toHaveAttribute('href', /app\.groundmail\.dev\/signup\?utm_source=groundhog/)
})
