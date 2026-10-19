---
"clerk": minor
---

Let AI agents take a Clerk application to production.

- `clerk deploy --domain <domain>` in agent mode creates the production instance (or resumes the existing one) without prompting and prints the deploy report. Without `--domain` it stays read-only. In the wizard, `--domain` skips the domain prompt and `--yes` skips the confirmations.
- When `clerk deploy --domain` finds an existing production instance whose domain Clerk hasn't returned yet, it refuses the domain with `deploy_domain_unchecked` instead of reporting as if it had been applied. A 404 on the production domain's status, in `clerk deploy`, `clerk deploy status`, or the wizard's DNS polling, fails with `deploy_instance_unresolved` instead of saying to re-link the directory.
- The deploy report gains `oauth.setup`: for each provider missing production credentials, the redirect URI, authorized origins, fields, and the `clerk config patch` payload and command that save them. `nextAction` now names the command to run instead of handing off to a human terminal. When native-only Sign in with Apple isn't ready in production, Apple is left out of `oauth.setup` so the native fix in `nextAction` isn't buried. Once Clerk's side is complete, `nextAction` says to pipe the production keys into the host's CLI without reading them.
- `clerk env pull --print` prints `KEY=value` lines to stdout instead of writing an env file, for sending production keys to a hosting provider. It fails without printing anything when Clerk returns no secret key, so a host is never handed half a key pair.
- `clerk config patch` and `clerk config put` no longer print secret values, in the diff they show before writing or in the response they print after (dry runs included).
