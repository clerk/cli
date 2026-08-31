---
"clerk": minor
---

Add native macOS support to `clerk init` and `clerk doctor`, including ClerkKit and optional AuthView setup, App Sandbox outgoing network access, Native Application reconciliation, and Sign in with Apple configuration. Multiplatform targets are validated across their supported iOS and macOS views and are automated only when they share one Clerk Swift application root and one case-insensitive Bundle ID. Targets that also ship an unmodeled platform such as visionOS or explicitly enable Mac Catalyst are diagnosed without applying automatic setup.
