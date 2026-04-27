---
"clerk": minor
---

Add `clerk users` command scaffolding with `clerk users create`, plus an interactive mode for the `users` family. The create wizard reads instance settings from the Frontend API to prompt only for enabled fields, marking required ones. A top-level interactive menu (`clerk users` with no subcommand) routes to registered actions; agent mode preserves the strict flag-driven contract. The application picker (used by `clerk link` and the `clerk users` wizard fallback) now lists the "Create a new application" option at the bottom, separated from existing apps and de-emphasized until highlighted, so it reads as a fallback rather than a primary choice.
