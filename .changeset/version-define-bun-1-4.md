---
"clerk": patch
---

Fix release binaries reporting a dev version when compiled with Bun 1.4.0: the `CLI_VERSION` define check moved out of the version macro (Bun 1.4.0 no longer substitutes `--define` globals during macro execution) into module code, so injected release versions are honored again.
