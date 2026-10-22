# Contributing to Groundhog

Thanks for helping. Bug reports, fixes and new providers are all welcome.

## Set up

You need Node 20 or newer (CI runs 22 and 24 on Linux, and 22 on Windows and macOS).

```bash
git clone https://github.com/Groundmail/groundhog.git
cd groundhog
npm install
npm run build
npm run dev            # builds, then starts the inbox at http://localhost:3025
```

Use `node dist/cli.js --http-port 3125 --smtp-port 1125` if the default ports are taken.

## Tests

```bash
npm run typecheck
npm test                         # Vitest: every provider SDK, SMTP, faults, webhooks, MCP, CLI
npx playwright install chromium
npm run test:e2e                 # the inbox UI and examples/playwright
```

The CLI tests use the built `dist/`, so run `npm run build` before `npm test`. Every change
should come with a test; for provider changes, the test sends through that provider's official
SDK (see `test/providers.test.ts`).

## Adding a provider

Each provider is one module in `src/providers/` that implements `ProviderModule`
(`src/providers/types.ts`):

1. **`register(router, hub)`**: add the provider's send routes under its own prefix
   (`/postmark/...`), parse the request into an email and call `hub.ingest()`. Call
   `hub.guard(ctx, provider)` first so failure mode applies. Answer with the same JSON the real
   API returns, so the official SDK accepts it.
2. **`fail(kind)`**: the provider's real error body and status for each failure kind
   (rate limit, invalid recipient, bad key, outage).
3. **`webhook(event, email, ctx)`** and **`eventNames`**: the provider's webhook payload,
   headers and signature for delivered, bounced, complained, opened and clicked.
4. Register it in `src/providers/index.ts`, add its id to `Provider` in `src/types.ts`, and add
   its label in `src/server.ts` and `src/ui/app.js`.
5. Add a test in `test/providers.test.ts` that sends with the provider's official SDK, and a row
   to the provider tables in `README.md`.

`src/providers/postmark.ts` is a small one to copy from.

## Pull requests

- Keep each PR to one change, and describe what a user will notice.
- `npm run typecheck`, `npm test` and `npm run test:e2e` should pass. CI runs them too.
- Don't bump the version in `package.json`; a maintainer does that when releasing (a version
  change on `main` publishes to npm).

By contributing you agree that your work is released under the [MIT License](LICENSE), and to
follow the [Code of Conduct](CODE_OF_CONDUCT.md).
