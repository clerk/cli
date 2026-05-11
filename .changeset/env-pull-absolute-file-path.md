---
"clerk": patch
---

Fix `clerk env pull --file <path>` to honor absolute paths. Previously, absolute paths were silently nested under the current working directory (e.g. `--file /Users/u/clerk-dev.env` wrote to `<cwd>/Users/u/clerk-dev.env`), making the file appear missing at the expected location while the success message claimed it was written there. Both absolute and relative paths now resolve correctly.
