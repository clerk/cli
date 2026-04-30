---
"clerk": minor
---

Remove `clerk init --prompt` and the bundled per-framework agent prompt templates. Agents should run `clerk init -y` to perform the full setup non-interactively, or run `skills add clerk/skills` directly via their preferred package runner. The internal `pmInstallCommand` helper has moved from `commands/init/prompts/` to `lib/package-manager.ts`.
