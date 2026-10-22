# Security

Groundhog is a development tool: it listens on `localhost` by default, never relays mail, and
its webhook signing keys are public on purpose. Don't expose it to the internet or run it in
production.

## Reporting a vulnerability

Please email **support@groundmail.dev** with "Groundhog security" in the subject, rather than
opening a public issue. Include the version (`npx @groundmail/groundhog --version`), how you
run it, and steps to reproduce. We'll reply within a few working days and credit you in the
release notes if you'd like.

Security fixes go into the latest release only.
