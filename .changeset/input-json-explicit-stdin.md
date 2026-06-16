---
"clerk": patch
---

Only read stdin as `--input-json` when `--input-json -` is passed explicitly. Previously any piped stdin was consumed and parsed as the options payload, which broke shell loops (`while read … | clerk …`) and commands that read their own stdin (`cat body.json | clerk api …`) with a confusing `invalid_json` error.
