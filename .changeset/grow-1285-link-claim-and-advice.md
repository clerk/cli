---
"clerk": minor
---

Make `clerk link` claim the application a signed-out `clerk init` created and link the folder to it, and make `clerk deploy` and `clerk deploy status` say how to link a folder that runs on an unclaimed application. If the claim fails or the workspace is managed by an integration, `clerk link` now stops with the error and says whether to rerun it or link another app with `--app`, instead of offering apps that can't include the claimed one. If the folder's publishable key belongs to a different application, `clerk link` and `clerk auth login` claim the application but leave the folder unlinked and its env files unchanged, and say which file holds the other key.
