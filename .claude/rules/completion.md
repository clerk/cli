---
description: Shell completion — how new commands and options get tab-completed
paths:
  - "packages/cli-core/src/commands/**"
  - "packages/cli-core/src/cli-program.ts"
  - "packages/cli-core/src/commands/completion/__complete.ts"
alwaysApply: false
---

`__complete.ts` walks the Commander.js command tree dynamically. Command names, aliases, flags, and any values declared with `.choices()` are completed automatically.

## When you add or change a command

**1. Fixed values that should also reject invalid input — use `.choices()`** (completions are automatic, no extra work):

```ts
.addArgument(createArgument("<path>", "Dashboard path").choices(["users", "api-keys"]))
.addOption(createOption("--format <fmt>", "Output format").choices(["json", "yaml"]))
```

**2. Common hint values, but the option also accepts other input — add to `KNOWN_OPTION_VALUES`** in `packages/cli-core/src/commands/completion/__complete.ts`:

```ts
"--my-flag": [
  { name: "value-a", description: "Description" },
],
```

Use this when `.choices()` would be too restrictive — e.g. `--instance` shows `dev`/`prod` but also accepts raw instance IDs.

Two options list fixed values here even though they reject anything outside the list, because they reject it in their handler rather than with `.choices()`: `clerk migrate import --source` (an unknown key gets the usage error that lists the valid sources) and `clerk feedback --outcome` (agent mode needs the JSON usage-error envelope and exit 2). Commander rejects a `.choices()` value with plain text and exit 1 before any hook runs, so neither could give its own error.

**3. Fully dynamic or user-specific values** (app IDs, file paths, live API data) — do nothing. The shell falls back to file completion or freeform input.

## Checklist

- [ ] Fixed known values → used `.choices()` → completions are automatic
- [ ] Hint-only values → added to `KNOWN_OPTION_VALUES` and added a test in `packages/cli-core/src/test/integration/completion.test.ts`
- [ ] Dynamic/user-specific values → no completion entry needed
