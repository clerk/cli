---
"clerk": minor
---

Make keyless mode the default for unauthenticated `clerk init` runs on keyless-capable frameworks, and add a `--login` flag to force the authenticated flow.

- Bootstrapping a new project while signed out now uses auto-generated temporary development keys instead of prompting for a browser login; running `clerk auth login` later claims the app automatically. Re-running init in an existing project while signed out still triggers the login flow.
- Agent-mode runs while signed out now set up keyless keys with a claim breadcrumb instead of printing manual setup guidance.
- `--keyless` now forces keyless mode even when signed in, including in existing projects. Combining it with `--login` or `--app` exits with a usage error.
- `--login` in agent mode while signed out exits with a usage error, since the browser login needs an interactive terminal.

Add keyless support to `clerk config pull` and `clerk config patch`, so an unclaimed keyless application can be configured without logging in.

- When the project isn't linked and no `--app` is passed, both commands use the instance secret key the project already holds and talk to the Backend API instead of the Platform API. This needs no account at all — no login and no `CLERK_PLATFORM_API_KEY`. If credentials happen to be present, the command still works and warns that linking would give the full configuration.
- Keyless payloads name Backend API resources directly: `instance`, `communication`, `restrictions`, `organization_settings`, `protect`, `oauth_application_settings`, and `instance_settings` (`test_mode`, `progressive_sign_up`, `from_email_address`, `restricted_to_allowlist`). Any other top-level key exits with a usage error naming the supported ones.
- `clerk config pull` returns the same envelope; `restrictions` and `instance_settings` are omitted because the Backend API has no read route for them.
- In keyless mode `--dry-run` previews the diff locally without sending anything, `--instance` exits with a usage error (the secret key already targets one instance), and `clerk config put` and `clerk config schema` explain that they need a claimed application.

Let more commands operate on an unclaimed keyless application, so an agent can bootstrap and configure Clerk end to end without an account.

- `clerk enable orgs` and `clerk disable orgs` now work without logging in, writing through the instance's own organization settings. `clerk enable/disable billing` still requires a claimed application and now says so directly, because Clerk's Backend API exposes no billing settings.
- `clerk whoami` reports the keyless instance — id, environment, publishable key, and where the key was found — instead of failing with "not logged in".
- `clerk env pull` writes a keyless application's locally-held keys into the project's env file instead of failing with "not linked".
- Every keyless-capable command now also finds the keys a Clerk SDK created for itself in `.clerk/.tmp/keyless.json`, so an application minted by running the dev server is reachable from the CLI.
- `clerk init --template <b2b-saas|b2c-saas|native|waitlist>` pre-configures the keyless application at creation — a `b2b-saas` app comes back with organizations already enabled. Keyless-only; combining it with `--login` exits with a usage error.
