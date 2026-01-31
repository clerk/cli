# CLAUDE.md

This file provides guidance for Claude Code when working with the Clerk CLI codebase.

## Project Overview

The Clerk CLI is a command-line interface for managing Clerk authentication instances. It's written in Go and distributed via:
- Homebrew (source build via Formula, signed .pkg via Cask)
- NPM (binary wrapper that downloads pre-built Go binaries)
- GitHub Releases (direct binary downloads)

## Tech Stack

- **Language**: Go 1.23+
- **CLI Framework**: [Cobra](https://github.com/spf13/cobra)
- **Interactive UI**: [Huh](https://github.com/charmbracelet/huh) (forms), [Bubbles](https://github.com/charmbracelet/bubbles) (TUI components)
- **Module Path**: `clerk.com/cli`

## Code Structure

```
cmd/clerk/
  main.go                 # Entry point

internal/
  api/                    # HTTP client layer
    client.go             # Base client with auth, retries, debug logging
    users.go              # Users API
    organizations.go      # Organizations API
    protect.go            # Protect Rules & Schema API
    billing.go            # Billing API
    ...                   # Other resource APIs

  cmd/                    # Cobra command definitions
    root.go               # Root command, global flags, prefix matching
    config.go             # Config, profile, alias commands
    users.go              # Users commands
    protect.go            # Protect commands
    ...                   # Other command groups

  config/                 # Configuration management
    config.go             # INI-based profiles
    aliases.go            # Command aliases (JSON)

  output/                 # Output formatting
    format.go             # Table/JSON/YAML formatting
    colors.go             # Terminal colors

  ai/                     # AI integration for rule generation
    ai.go                 # Provider abstraction
    openai.go             # OpenAI provider
    anthropic.go          # Anthropic provider
    mcp.go                # MCP client for external tools

scripts/
  postinstall.js          # NPM postinstall (downloads Go binary)
  build-macos-pkg.sh      # macOS signing and packaging
  export-certs-for-github.sh  # Certificate export helper

Formula/
  clerk.rb                # Homebrew Formula (builds from source)

Casks/
  clerk.rb                # Homebrew Cask (uses signed .pkg)
```

## Development Commands

```bash
# Build
make build                # or: go build -o clerk ./cmd/clerk

# Run locally
./clerk --help
./clerk users list

# Run tests
make test                 # or: go test -race ./...

# Format code
make fmt                  # gofmt + goimports

# Lint
make lint                 # Run golangci-lint
make lint-fix             # Run golangci-lint with auto-fix

# Security scanning
make security             # Run gosec
make vulncheck            # Check for known vulnerabilities

# Run all checks before pushing
make check                # fmt + vet + lint + test
make check-all            # Above + security + vulncheck
```

## Setup Development Environment

```bash
# Install all development tools (golangci-lint, gosec, govulncheck, goimports)
make setup

# Install git pre-commit hook
make setup-hooks
```

The pre-commit hook runs on staged Go files:
- Format check (gofmt)
- go vet
- golangci-lint (incremental)
- Short tests

To skip the hook for a specific commit: `git commit --no-verify`

## Linting & Security

The project uses comprehensive linting via `.golangci.yml`:

### Enabled Linters

| Category | Linters |
|----------|---------|
| **Security** | gosec, bodyclose, noctx |
| **Bugs** | govet, staticcheck, durationcheck, nilerr, nilnil |
| **Code Quality** | gocritic, errcheck, ineffassign, unconvert, unparam |
| **Style** | gofmt, goimports, revive, misspell, errname, errorlint |

### CI Pipeline

The CI workflow (`.github/workflows/ci.yml`) runs:

1. **Lint job**: golangci-lint with full configuration
2. **Security job**: gosec + govulncheck for vulnerability scanning
3. **Build & Test job**: Cross-platform build and test with race detection

Build & Test only runs after Lint passes.

### Running Checks Locally

```bash
# Quick check before committing (recommended)
make check

# Full check including security scanning
make check-all

# Fix auto-fixable lint issues
make lint-fix
```

## Key Patterns

### Adding a New Command

1. Create API methods in `internal/api/<resource>.go`
2. Create command file in `internal/cmd/<resource>.go`
3. Register commands in `internal/cmd/root.go`

### Version Injection

Version is injected at build time via ldflags:
```bash
go build -ldflags "-X clerk.com/cli/internal/cmd.Version=v1.0.0" ./cmd/clerk
```

The variable is defined in `internal/cmd/root.go`.

### Configuration

- Profiles stored in `~/.config/clerk/cli/profiles` (INI format)
- Values prefixed with `!` are shell commands executed to fetch secrets
- Active profile set in `[default]` section or via `CLERK_PROFILE` env var

## Releasing

### Creating a Release with Release Notes

Releases are triggered by pushing a git tag. To include release notes in the GitHub Release:

#### Option 1: Annotated Tag with Release Notes (Recommended)

```bash
# Create an annotated tag with release notes in the message body
git tag -a v1.0.0 -m "Release v1.0.0

## What's New

- Added new feature X
- Improved performance of Y
- Fixed bug in Z

## Breaking Changes

- Changed API for foo()

## Contributors

Thanks to @user1 and @user2 for their contributions!"

# Push the tag
git push origin v1.0.0
```

The release workflow extracts the tag annotation body and uses it as the GitHub Release notes.

#### Option 2: Create Draft Release First

```bash
# Create the tag
git tag v1.0.0
git push origin v1.0.0

# Before the workflow runs, create a draft release with notes via GitHub UI or CLI
gh release create v1.0.0 --draft --title "v1.0.0" --notes "## What's New
- Feature X
- Feature Y"
```

The workflow preserves existing release notes if found.

#### Option 3: Edit Release Notes After

Push the tag, let the workflow create the release, then edit the notes:

```bash
git tag v1.0.0
git push origin v1.0.0

# After release is created, edit it
gh release edit v1.0.0 --notes "Updated release notes here"
```

### Release Workflow Overview

When a tag matching `v*` is pushed, `.github/workflows/release.yml`:

1. **build** job (ubuntu-latest):
   - Cross-compiles Go binaries for 6 platforms (darwin/linux/windows × amd64/arm64)
   - Uploads artifacts for subsequent jobs

2. **sign-macos** job (macos-latest, if `MACOS_SIGNING_ENABLED=true`):
   - Downloads darwin binaries
   - Signs binaries with Developer ID Application certificate
   - Builds .pkg installers with pkgbuild
   - Signs .pkg with Developer ID Installer certificate
   - Notarizes with Apple and staples tickets
   - Uploads signed .pkg files

3. **release** job (ubuntu-latest):
   - Downloads all artifacts
   - Creates checksums.txt
   - Creates/updates GitHub Release with all files
   - Updates Formula/clerk.rb, Casks/clerk.rb, and package.json versions
   - Commits version updates to main branch

### Version Naming

- Tags must start with `v` (e.g., `v1.0.0`, `v0.1.0-beta.1`)
- The `v` prefix is stripped for package.json and Cask versions
- Follow semantic versioning: `vMAJOR.MINOR.PATCH[-PRERELEASE]`

### Release Artifacts

Each release includes:
- `clerk-v{VERSION}-darwin-amd64` - macOS Intel binary
- `clerk-v{VERSION}-darwin-arm64` - macOS Apple Silicon binary
- `clerk-v{VERSION}-darwin-amd64.pkg` - Signed macOS Intel installer (if signing enabled)
- `clerk-v{VERSION}-darwin-arm64.pkg` - Signed macOS Apple Silicon installer (if signing enabled)
- `clerk-v{VERSION}-linux-amd64` - Linux x86_64 binary
- `clerk-v{VERSION}-linux-arm64` - Linux ARM64 binary
- `clerk-v{VERSION}-windows-amd64.exe` - Windows x86_64 binary
- `clerk-v{VERSION}-windows-arm64.exe` - Windows ARM64 binary
- `checksums.txt` - SHA256 checksums for all files

## macOS Code Signing

### Prerequisites

1. Apple Developer Program membership ($99/year)
2. Developer ID Application certificate
3. Developer ID Installer certificate
4. App-Specific Password for notarization

### GitHub Secrets Required

| Secret | Description |
|--------|-------------|
| `APPLE_DEVELOPER_ID_APPLICATION_P12` | Base64 .p12 of Developer ID Application cert |
| `APPLE_DEVELOPER_ID_INSTALLER_P12` | Base64 .p12 of Developer ID Installer cert |
| `APPLE_CERTIFICATE_PASSWORD` | Password for .p12 files |
| `APPLE_ID` | Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | 10-character Team ID |
| `APPLE_DEVELOPER_NAME` | Name as shown in certificate |

### Repository Variable

Set `MACOS_SIGNING_ENABLED=true` to enable the signing job.

### Exporting Certificates

```bash
# Run helper script to get base64-encoded values
./scripts/export-certs-for-github.sh
```

## Testing Changes Locally

### Test a Command

```bash
go run ./cmd/clerk users list --debug
```

### Test the NPM Package

```bash
# Build binary
go build -o bin/clerk-bin ./cmd/clerk

# Test the wrapper
node bin/clerk --help
```

### Test Homebrew Formula

```bash
# Install from local formula
brew install --build-from-source ./Formula/clerk.rb

# Or test the tap
brew tap clerk/cli .
brew install clerk/cli/clerk
```

## Common Tasks

### Add a New API Endpoint

1. Add types and methods to `internal/api/<resource>.go`
2. Add command in `internal/cmd/<resource>.go`
3. Wire up in parent command's `init()` function

### Update Dependencies

```bash
go get -u ./...
go mod tidy
```

### Debug HTTP Requests

Use `--debug` flag or set `CLERK_CLI_DEBUG=1`:

```bash
clerk --debug users list
CLERK_CLI_DEBUG=1 clerk protect rules list SIGN_IN
```

This logs all HTTP requests/responses to stderr.
