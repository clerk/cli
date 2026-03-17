# Release Flow

This document describes how the Clerk CLI is built, versioned, and published.

## Overview

```
push to main
  → release-please creates/updates a version PR
    → merge version PR
      → release-please creates a GitHub Release + tag
        → build job: cross-compile binaries (8 targets)
          → smoke-test job: verify binaries on native runners
            → publish-npm: generate platform packages + publish wrapper
            → upload-github-assets: attach binaries to the GitHub Release
    → (if no release created) canary job: build + smoke-test subset + publish @canary

PR comment "!snapshot [name]"
  → build job: cross-compile binaries from PR branch
    → smoke-test job: verify linux-x64 binary
      → publish-npm: publish @snapshot packages
        → post installation comment on PR
```

## Architecture

The CLI is distributed as an npm wrapper package (`clerk`) plus one platform-specific package per target (e.g., `@clerk/cli-darwin-arm64`). The full list of platform targets is defined in [`scripts/releaser/targets.ts`](../scripts/releaser/targets.ts).

When a user runs `npm install -g clerk`, npm installs the wrapper plus the matching platform package via `optionalDependencies`. The wrapper's `bin/clerk` shim resolves the binary from the platform package using `require.resolve()`.

Target names follow Node.js's `${process.platform}-${process.arch}` convention so the shim can derive package names without a lookup table.

## Release Channels

### Stable (`@latest`)

Published when a release-please version PR is merged. Includes full smoke testing on native runners before publishing. Binaries are also attached to the GitHub Release.

Install: `npm install -g clerk`

### Canary (`@canary`)

Published automatically on every push to `main` that does **not** trigger a stable release. Canary versions use the format `x.y.z-canary.<short-sha>` (e.g., `0.0.1-canary.abc1234`). A subset of smoke tests (darwin-arm64, linux-x64, linux-x64-musl) runs before publishing.

Install: `npm install -g clerk@canary`

### Snapshot (`@snapshot`)

Published on-demand from PR branches by commenting `!snapshot` (or `!snapshot <name>`) on a pull request. The commenter must be a member or owner of the repository's organization. Snapshot versions use the format `x.y.z-<name>.v<YYYYMMDDHHmmss>` (e.g., `0.0.1-snapshot.v20260313145959` or `0.0.1-my-feature.v20260313145959`). The datetime format ensures multiple snapshots from the same PR sort monotonically in semver.

Install: `npm install -g clerk@<version>` (version is posted as a PR comment after publishing)

## Versioning

Versioning is managed by [release-please](https://github.com/googleapis/release-please). On every push to `main`, it either creates a new version PR or updates an existing one based on conventional commit messages. Merging that PR triggers a GitHub Release.

Configuration:

- `release-please-config.json` — release-please settings (release type, package path)
- `.release-please-manifest.json` — tracks the current version

## Build Pipeline

The release workflow (`.github/workflows/release.yml`) runs when release-please creates a release. Binary compilation is handled by a reusable workflow (`.github/workflows/build-binaries.yml`) shared across stable, canary, and snapshot pipelines. Build and publish jobs run on Blacksmith runners (`blacksmith-2vcpu-ubuntu-2404`); smoke tests run on platform-native GitHub-hosted runners.

### 1. Build Job (matrix)

Defined in [`.github/workflows/build-binaries.yml`](../.github/workflows/build-binaries.yml) and called by the release, canary, and snapshot pipelines. Runs once per target platform on a Blacksmith runner. Each job:

1. Cross-compiles the CLI using `bun build --compile --no-compile-autoload-dotenv --target=<bun_target>`
2. Injects the version via `--define "CLI_VERSION=\"$CLI_VERSION\""`
3. Verifies the binary format using `file` output
4. Uploads the binary as a GitHub Actions artifact

### 2. Smoke Test Job (matrix)

Downloads each compiled binary and runs `--version` to verify the binary actually executes. Smoke testing is handled by a reusable workflow (`.github/workflows/smoke-test.yml`) shared across stable, canary, and snapshot pipelines. Each caller passes a preset name (`stable`, `canary`, or `snapshot`); the reusable workflow resolves the preset to a target matrix internally. glibc targets run natively on a platform-matched GitHub-hosted runner; musl targets run inside an Alpine Docker container on a Linux runner.

Not all targets have a native runner available. `win32-arm64` is published as best-effort — the build job verifies it is a valid PE32+/Aarch64 binary via `file` output, but no execution-level smoke test runs because there is no GitHub-hosted ARM Windows runner.

Publishing and GitHub Release upload are gated on all smoke tests passing.

### 3. Publish npm Job

Runs the releaser script (`scripts/releaser/index.ts`):

1. Reads the version from `packages/cli/package.json` (or uses `--version` override for canary/snapshot)
2. For each target, generates a platform package in `dist/platform-packages/`:
   - Creates `package.json` with `os`/`cpu` fields for npm platform selection
   - Copies the compiled binary from the build artifacts
3. Publishes each platform package with `--access public` (authentication and provenance use npm OIDC trusted publishing — no `NPM_TOKEN` secret needed, just `id-token: write` permission on a GitHub-hosted runner)
4. Temporarily mutates the wrapper `package.json` to add `optionalDependencies` and remove `private: true`, publishes it, then restores the original file

The releaser accepts these flags:

- `--dry-run` — simulate publishing without actually uploading to npm
- `--tag <tag>` — publish with a specific npm dist-tag (e.g., `canary`, `snapshot`); defaults to `latest`
- `--version <version>` — override the version read from `package.json`

All publishes are idempotent — the script checks `npm view` before publishing and skips already-published versions.

#### Environment Variables

The releaser script and publish workflow steps use these environment variables:

- `ARTIFACTS_DIR` — path to directory containing compiled binaries from the build job (defaults to `./dist/artifacts`)

#### npm Authentication

Publishing uses [npm OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers/) instead of stored secrets. The publish jobs run on GitHub-hosted runners with `id-token: write` permission, and npm >= 11.5.1 automatically authenticates via GitHub's OIDC provider. Each package must have a trusted publisher configured on npmjs.com pointing to the correct workflow file.

> **First publish**: New packages cannot use trusted publishing until they exist on npm. The very first stable release requires a one-time `NODE_AUTH_TOKEN` with a granular access token. After that, configure trusted publishers for all packages and remove the token.

### 4. Upload GitHub Assets Job

Attaches the compiled binaries to the GitHub Release for direct download. Binaries are uploaded with display names following the `clerk-<target>` convention (e.g., `clerk-darwin-arm64`, `clerk-win32-x64.exe`).

## Key Files

| File                                   | Purpose                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/cli/bin/clerk`               | CJS shim that resolves and spawns the platform binary                          |
| `packages/cli/package.json`            | Wrapper package (has `prepublishOnly` guard against accidental direct publish) |
| `packages/cli-core/src/cli.ts`         | CLI entrypoint (reads `CLI_VERSION` global at runtime)                         |
| `packages/cli-core/src/globals.d.ts`   | TypeScript declaration for the `CLI_VERSION` compile-time define               |
| `scripts/releaser/index.ts`            | Generates platform packages and publishes everything to npm                    |
| `scripts/releaser/targets.ts`          | Target definitions — must be kept in sync with the workflow matrix             |
| `.github/workflows/build-binaries.yml` | Reusable workflow for cross-compiling binaries (called by release + snapshot)  |
| `.github/workflows/smoke-test.yml`     | Reusable workflow for smoke-testing binaries (called by release + snapshot)    |
| `.github/workflows/release.yml`        | GitHub Actions release + canary workflow                                       |
| `.github/workflows/snapshot.yml`       | GitHub Actions snapshot workflow (triggered by PR comments)                    |

## Keeping Targets in Sync

The target list exists in these places that must stay in sync:

1. `scripts/releaser/targets.ts` — used by the releaser to generate platform packages
2. `.github/workflows/build-binaries.yml` build matrix — compiles binaries (maps target names to Bun cross-compile targets, e.g., `win32-x64` → `bun-windows-x64`)
3. `.github/workflows/smoke-test.yml` preset definitions — defines the target matrix for each preset (`stable`, `canary`, `snapshot`)

If you add or remove a target, update all of these. Note that the smoke-test presets may not cover every target if a native runner isn't available (e.g., `win32-arm64`).

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
- **Org membership check**: Snapshot releases require the commenter to be a `MEMBER` or `OWNER` of the repository's organization, verified via `author_association`.
- **OIDC trusted publishing**: Publish jobs authenticate via GitHub's OIDC provider instead of stored npm tokens. This eliminates secret rotation, prevents token exfiltration, and scopes publish permissions to specific workflow files.
- **CI build check**: Every PR to `main` runs a JS bundle build to catch bundler-specific failures before merge.
