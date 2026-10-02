---
"clerk": minor
---

Add iOS and macOS setup to `clerk init`. Discover Xcode projects and workspace targets, install and resolve Clerk Swift packages, configure capabilities, register the native application, and optionally enable native Sign in with Apple. Support both classic and JSON Xcode project formats.

Initialize unchanged SwiftUI starter apps directly, with optional prebuilt sign-in UI. Preserve customized application code and provide a structured agent handoff with relevant SDK documentation for remaining integration work.

Add read-only native checks to `clerk doctor`. Report unfinished setup clearly and recover earlier local edits when a later write fails.

Allow agent-driven authenticated setup, including explicit `--login`, to open browser login and continue after the user signs in. Preserve automatic accountless selection for supported web frameworks; API keys are checked by setup requests without an extra authentication precheck.
