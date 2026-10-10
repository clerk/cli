---
"clerk": minor
---

Let AI agents run `clerk deploy` end to end and hand production keys to a hosting provider.

- `clerk deploy --domain <domain>` creates (or resumes) the production instance without prompts; `--yes` skips the confirmations, `--no-clone` creates a blank production instance when your plan blocks cloning development settings, and `--zone-file <path>` writes the DNS records as a BIND zone file.
- In agent mode, `--domain` mutates and prints the deploy report with `created`, `warnings`, `zoneFile`, per-record `required`, and `oauth.setup` guidance: the fields, redirect URI, and exact `clerk config patch` command for each pending provider. Without `--domain` the run stays read-only, and every `nextAction` now names the command to run instead of handing off to a human terminal.
- Skipping an OAuth provider in the deploy wizard no longer pauses the deploy; DNS verification runs and the provider is reported as pending. `clerk deploy status` still requires credentials before reporting `complete`.
- Plan-insufficient errors include a `--no-clone` retry example.
- `clerk env pull --print` prints `KEY=value` lines to stdout instead of writing an env file.
