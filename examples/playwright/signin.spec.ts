import { expect, test } from '@playwright/test'
import { waitForEmail } from '@groundmail/groundhog'

test('magic-link sign-in', async ({ page }) => {
  const to = `ada+${Date.now()}@example.com`

  await page.goto('http://localhost:3999/')
  await page.getByLabel('Email').fill(to)
  await page.getByRole('button', { name: 'Email me a link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()

  const email = await waitForEmail({ to })
  expect(email.subject).toBe('Sign in to Acme')
  expect(email.code).toMatch(/^\d{6}$/)

  await page.goto(email.links[0])
  await expect(page.getByRole('heading', { name: `Signed in as ${to}` })).toBeVisible()
})
