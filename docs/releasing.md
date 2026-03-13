# Release Flow

This document describes how the Clerk CLI is built, versioned, and published.

## Overview

```
push to main
  → release-please creates/updates a version PR
    → merge version PR
      → release-please creates a GitHub Release + tag
        → build job: cross-compile binaries (6 targets)
          → smoke-test job: verify binaries on native runners (5 targets)
            → publish-npm: generate platform packages + publish wrapper
            → upload-github-assets: attach binaries to the GitHub Release
```

## Architecture

The CLI is distributed as an npm wrapper package (`@clerk/cli`) plus one platform-specific package per target (e.g., `@clerk/cli-darwin-arm64`). The full list of platform targets is defined in [`scripts/releaser/targets.ts`](../scripts/releaser/targets.ts).

When a user runs `npm install -g @clerk/cli`, npm installs the wrapper plus the matching platform package via `optionalDependencies`. The wrapper's `bin/clerk` shim resolves the binary from the platform package using `require.resolve()`.

Target names follow Node.js's `${process.platform}-${process.arch}` convention so the shim can derive package names without a lookup table.

## Versioning

Versioning is managed by [release-please](https://github.com/googleapis/release-please). On every push to `main`, it either creates a new version PR or updates an existing one based on conventional commit messages. Merging that PR triggers a GitHub Release.

Configuration:

- `release-please-config.json` — release-please settings (release type, package path)
- `.release-please-manifest.json` — tracks the current version

## Build Pipeline

The release workflow (`.github/workflows/release.yml`) runs when release-please creates a release. Build and publish jobs run on Blacksmith runners (`blacksmith-2vcpu-ubuntu-2404`); smoke tests run on platform-native GitHub-hosted runners.

### 1. Build Job (matrix)

Runs once per target platform on a Blacksmith runner. Each job:

1. Cross-compiles the CLI using `bun build --compile --no-compile-autoload-dotenv --target=<bun_target>`
2. Injects the version via `--define "CLI_VERSION=\"$CLI_VERSION\""`
3. Verifies the binary format using `file` output
4. Uploads the binary as a GitHub Actions artifact

### 2. Smoke Test Job (matrix)

Downloads each compiled binary and runs `--version` on a native runner for that platform to verify the binary actually executes. The target-to-runner mapping is defined in the `smoke-test` matrix in [`.github/workflows/release.yml`](../.github/workflows/release.yml).

Not all targets may have a native runner available (e.g., `win32-arm64` is skipped because there is no GitHub-hosted ARM Windows runner).

Publishing and GitHub Release upload are gated on all smoke tests passing.

### 3. Publish npm Job

Runs the releaser script (`scripts/releaser/index.ts`):

1. Reads the version from `packages/cli/package.json`
2. For each target, generates a platform package in `dist/platform-packages/`:
   - Creates `package.json` with `os`/`cpu` fields for npm platform selection
   - Copies the compiled binary from the build artifacts
3. Publishes each platform package with `--provenance --access public`
4. Temporarily mutates the wrapper `package.json` to add `optionalDependencies` and remove `private: true`, publishes it, then restores the original file

All publishes are idempotent — the script checks `npm view` before publishing and skips already-published versions.

### 4. Upload GitHub Assets Job

Attaches the compiled binaries to the GitHub Release for direct download. Binaries are uploaded with display names following the `clerk-<target>` convention (e.g., `clerk-darwin-arm64`, `clerk-win32-x64.exe`).

## Key Files

| File                                 | Purpose                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| `packages/cli/bin/clerk`             | CJS shim that resolves and spawns the platform binary                          |
| `packages/cli/package.json`          | Wrapper package (has `prepublishOnly` guard against accidental direct publish) |
| `packages/cli-core/src/cli.ts`       | CLI entrypoint (reads `CLI_VERSION` global at runtime)                         |
| `packages/cli-core/src/globals.d.ts` | TypeScript declaration for the `CLI_VERSION` compile-time define               |
| `scripts/releaser/index.ts`          | Generates platform packages and publishes everything to npm                    |
| `scripts/releaser/targets.ts`        | Target definitions — must be kept in sync with the workflow matrix             |
| `.github/workflows/release.yml`      | GitHub Actions release workflow                                                |

## Keeping Targets in Sync

The target list exists in three places that must stay in sync:

1. `scripts/releaser/targets.ts` — used by the releaser to generate platform packages
2. `.github/workflows/release.yml` build matrix — compiles binaries (maps target names to Bun cross-compile targets, e.g., `win32-x64` → `bun-windows-x64`)
3. `.github/workflows/release.yml` smoke-test matrix — verifies binaries on native runners

If you add or remove a target, update all three. Note that the smoke-test matrix may not cover every target if a native runner isn't available (e.g., `win32-arm64`).

## Local Development

To build a compiled binary locally for your native platform:

```sh
bun run --filter @clerk/cli-core build:compile
./packages/cli-core/dist/clerk --version  # prints "0.0.0-dev"
```

This does not inject a version (falls back to `0.0.0-dev`) and only builds for your current platform. The release workflow handles cross-compilation and version injection.

To test the releaser without publishing:

```sh
bun run scripts/releaser/index.ts --dry-run
```

## Safeguards

- **`prepublishOnly` guard**: The wrapper `package.json` has a `prepublishOnly` script that exits with an error, preventing accidental `npm publish` from the package directory. The releaser bypasses this with `--ignore-scripts`.
- **`private: true`**: Both `packages/cli` and `packages/cli-core` are marked private. The releaser removes this flag from the wrapper before publishing and restores it afterward.
- **Idempotent publishing**: The releaser checks npm before publishing and skips already-published versions, making it safe to re-run.
- **Binary format verification**: The build job verifies each compiled binary matches its expected architecture before uploading.
- **Native smoke tests**: Each binary is executed on a native runner for its platform before publishing. This catches cross-compilation issues that format checks alone would miss.
