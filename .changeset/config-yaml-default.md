---
"clerk": major
---

**Breaking:** `clerk config pull` now outputs **YAML by default** instead of JSON. Anything parsing its stdout as JSON (e.g. `clerk config pull | jq`, or agents/scripts that assume JSON) will break until updated. Pass `--json` to restore JSON output; a `--output` path ending in `.json` also writes JSON.

Additionally, `clerk config patch` and `clerk config put` now accept YAML input (a superset of JSON, so existing JSON files keep working) and, when no `--file`/`--json`/stdin is provided, auto-detect a project config file in order: `.clerk/config.yaml` → `.clerk/config.yml` → `.clerk/config.json` (first found wins).

Migration: add `--json` to any `clerk config pull` invocation whose output is consumed as JSON.
