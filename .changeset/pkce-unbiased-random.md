---
"clerk": patch
---

Fix biased character distribution in PKCE code verifier generation. Replaces `byte % CHARSET.length` with rejection sampling so every character in the 66-entry charset is equally likely, restoring full entropy.
