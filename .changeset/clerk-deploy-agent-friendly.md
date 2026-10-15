---
"clerk": minor
---

Let AI agents take a Clerk application to production.

- `clerk deploy --domain <domain>` in agent mode creates the production instance (or resumes the existing one) without prompting and prints the deploy report. Without `--domain` it stays read-only. In the wizard, `--domain` skips the domain prompt and `--yes` skips the confirmations.
- The deploy report gains `oauth.setup`: for each provider missing production credentials, the redirect URI, authorized origins, fields, and the `clerk config patch` payload and command that save them. `nextAction` now names the command to run instead of handing off to a human terminal.
- `clerk env pull --print` prints `KEY=value` lines to stdout instead of writing an env file, for sending production keys to a hosting provider.
- `clerk config patch` and `clerk config put` no longer print secret values in the diff they show before writing.
