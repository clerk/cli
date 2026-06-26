---
"clerk": patch
---

Improve how API error responses are displayed: when a response contains multiple errors they are now all shown instead of just the first, and bodies that carry a plain `error` or `message` field are surfaced directly rather than as raw JSON.
