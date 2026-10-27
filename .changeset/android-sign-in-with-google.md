---
"clerk": minor
---

Native Sign in with Google for Android: `clerk init --sign-in-with-google` (or a yes to the new prompt) enables Clerk's Google connection for authentication and sets a Google Web client as its custom credentials, which the Android SDK reads as the One Tap client ID. The client comes from `--google-client-id` and `--google-client-secret-file` (a path or `-` for standard input; never an argument) or from a prompt; a connection that already has a Web client is left alone. The write is a dry-run PATCH, then the same `If-Match` write, then a verifying read. The preview and the agent handoff carry the Google Cloud steps with the package name and the debug certificate's SHA-1, and `clerk doctor` checks the connection, its Web client ID, and notes the Android OAuth client it can't verify.
