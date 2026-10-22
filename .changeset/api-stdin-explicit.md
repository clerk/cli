---
"clerk": patch
---

`clerk api` no longer reads stdin as a request body unless you pass `--file -`. An open unread stdin (CI, agents, `sleep | clerk api`) cannot hang a GET.
