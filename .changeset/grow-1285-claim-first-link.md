---
"clerk": patch
---

Make `clerk link`, `clerk init`, and `clerk auth login` link the folder's own application, and make every command that stops in an unlinked folder say what to run next for what that folder holds.

- `clerk link` (and `clerk init` through it) first claims an application `clerk init` created in the folder, then matches the publishable key the app actually loads, in the framework's env file order. For an application a Clerk SDK created for itself, it links it when it's in your account and otherwise opens its claim page. `clerk auth login` asks before claiming, and a claim never relinks a folder or overwrites its keys with another application's.
- `clerk deploy`, `clerk deploy status`, `clerk doctor`, `clerk open`, `clerk env pull`, `clerk whoami`, and the commands that run on the folder's secret key give the same next step for the same folder, call an application unclaimed only when it isn't in any account yet, and read the folder's keys the way `clerk link` does.
