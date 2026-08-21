---
description: Use compile-time version constants for CLI version consumers
paths:
  - "packages/cli-core/src/**/*.ts"
alwaysApply: false
---

Use the exported constants from `packages/cli-core/src/lib/version.ts` for the
current CLI version rather than adding accessor functions:

```ts
import { CURRENT_VERSION, IS_DEV_BUILD } from "./version.ts";
```

- Read `CURRENT_VERSION` when displaying or sending the current version,
  including CLI help, user-agent headers, and MCP client info.
- Read `IS_DEV_BUILD` when behavior depends on whether the binary is a
  development build.
- Keep checkout-derived version generation in `version.macro.ts`; the compiled
  CLI must not execute Git at runtime. The `CLI_VERSION` define check and dev
  classification live in `version.ts` module code — Bun 1.4.0 stopped
  substituting `--define` globals inside macro execution, so the macro must
  never read `CLI_VERSION` itself.

The constants are evaluated while Bun transpiles or compiles the module, so
release builds can use the injected `CLI_VERSION` while local builds retain
their checkout metadata.
