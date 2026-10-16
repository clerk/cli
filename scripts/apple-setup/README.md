# Apple setup verification

The implementation is in `packages/cli-core/src/commands/init/ios/`, used by
public `clerk init` and `clerk doctor`. See
[iOS and macOS setup](../../packages/cli-core/src/commands/init/README.md#ios-and-macos-swift).

These scripts exercise actual Xcode against disposable fixtures. They use fake
Clerk APIs and never modify a customer application or live Clerk settings.

```sh
bun test packages/cli-core/src/commands/init/ios --parallel
bun scripts/apple-setup/verify-xcode.ts
bun scripts/apple-setup/verify-capabilities.ts
bun scripts/apple-setup/verify-packages.ts
bun scripts/apple-setup/verify-ownership.ts
bun scripts/apple-setup/verify-production.ts
```

The package probe downloads Clerk, verifies lockfile entries, and builds the
starter with initialization and requested AuthView UI for both iOS and macOS,
in both project formats. Builds are unsigned. It does not verify provisioning or
actual sign-in. Build logs are written to `/tmp/clerk-setup-build-*.log`.

Capability probes cover Debug/Release, existing/new entitlements, preservation,
and no-op reruns. Both probes also exercise public `clerk init --dry-run --json`.
The CLI selects a compatible installed Xcode for `.xcproj` when necessary.

The ownership probe checks that Xcode's resolved settings, not file names, decide
whether another target shares the app's entitlements (xcconfigs, `#include`
chains, and CocoaPods-style files).

The production probe checks that Xcode's resolved settings carry what doctor's
production checks read: a per-configuration xcconfig key surfaced through an
Info.plist entry and a Release-only entitlements file, and that `#if DEBUG`
literals, which doctor doesn't read, report the key as not verified.
