---
"clerk": patch
---

Keep `--define CLI_VERSION` working when building with Bun 1.4.

Bun 1.4 runs macros in a sealed transpiler context that `--define` globals no longer reach, so the version macro silently fell back to the checkout-derived dev version even when a release version was injected. The define check and dev classification now live in `version.ts` module scope, where define substitution still applies; the macro only derives the Git checkout fallback.
