# Established Swift app

This fixture derives from the real Xcode 26.5 iOS App template in the native
project corpus (generated September 21, 2026). Its original project document,
synchronized source group, build configurations, workspace, and asset catalogs
are retained. The changes add an existing navigation hierarchy, a delegated
authentication service, a custom Info.plist key source, and entitlements with a
literal App ID Prefix and an existing associated domain.

The app calls `AuthenticationService.start()` from its initializer. That service
calls `Clerk.configure`, which is intentionally outside the CLI's proven startup
patterns. The CLI must preserve it without executing the service or reading its
custom key value. There is no credential in this fixture. Building is supported
after SDK linkage; launching requires the developer's `ClerkPublishableKey`
Info.plist value and a working authentication flow.

`established-app.test.ts` starts with partial package integration, runs the actual
CLI against an isolated HTTP stub, and reruns against the resulting installed SDK
and registered native application. It checks unchanged Swift and entitlements,
no duplicate remote mutations, and explicit remaining runtime verification.
It also repeats that lifecycle with the CLI-generated AuthView already present,
checking that both SDK products can be linked without rewriting existing UI or
implicitly activating AuthView provider setup. Explicit AuthView setup with
unproven runtime wiring must still fail before any mutation.
Negative cases cover incomplete source membership, conflicting Bundle IDs,
missing App ID Prefix, missing explicit application selection, and unsafe prebuilt
UI insertion. Doctor tests add an unresolved source build-file record while
keeping independently readable target identity.

The HTTP stub proves command behavior, not live authentication. A separate local
validation built the CLI-modified fixture with Xcode 26.5 for a generic iOS
Simulator destination, with code signing disabled. No package pins, derived data,
or developer-specific Xcode files belong in this fixture.
