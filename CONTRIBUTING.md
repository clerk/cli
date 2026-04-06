# Contributing

When contributing to this repository, please first discuss the change you wish to make via issue or any other method with the owners of this repository before making a change.

## Developing locally

### Prerequisites

- [Bun](https://bun.sh/) (latest version)
- [Git](https://git-scm.com/)

### Setting up your local environment

1. Clone the repo

```sh
git clone https://github.com/clerk/cli
cd cli
```

2. Install dependencies

```sh
bun install
```

3. Run the CLI from source (fastest, no compilation)

```sh
bun run dev
```

4. Or compile a native binary and run it

```sh
bun run start -- --help
```

### Installing pre-release versions

In addition to running from source, you can install pre-release builds published to npm.

**Canary** — published automatically on every push to `main` that does not trigger a stable release:

```sh
npm install -g clerk@canary
```

**Snapshot** — published on-demand from PR branches by commenting `!snapshot` (or `!snapshot <name>`) on a pull request. The commenter must be a member or owner of the repository's organization. The exact version to install is posted as a PR comment after publishing:

```sh
npm install -g clerk@<version>
```

See [docs/releasing.md](docs/releasing.md) for full details on release channels and version formats.

### CI checks

After modifying files, run these commands to match what CI enforces on pull requests:

```sh
bun run format       # Format with oxfmt (writes changes)
bun run lint         # Lint with oxlint
bun test             # Run unit tests
bun run test:e2e:op  # Run E2E tests with secrets from 1Password (preferred locally)
bun run test:e2e     # Run E2E tests with env vars already set (CI / non-1Password setups)
```

### Writing tests

When changing functionality or adding new code, add or update tests to verify the new behavior. Tests use Bun's built-in test runner:

```sh
bun test
```

Check for existing `*.test.ts` files near the code you're modifying.

### E2E tests

E2E tests verify that `clerk init` produces a buildable, type-safe project with working browser auth for each supported framework (Next.js, React, Vue, Nuxt, Astro, React Router, TanStack Start). They require a Clerk staging application and credentials.

**Locally, prefer `bun run test:e2e:op`.** It wraps `test:e2e` in `op run`, which resolves the required secrets from 1Password in-memory so nothing ever lands on disk. Any flags you pass are forwarded to the underlying runner:

```sh
bun run test:e2e:op                          # Run all E2E tests (secrets from 1Password)
bun run test:e2e:op -- --filter react        # Run only tests matching "react"
bun run test:e2e:op -- --debug               # Verbose helper logging (sets CLERK_E2E_DEBUG=1)
bun run test:e2e:op -- --har                 # Capture HAR files to test/e2e/.har for network debugging
bun run test:e2e:op -- --har-dir ./out       # Capture HAR files to a custom directory
bun run e2e:refresh-fixtures                 # Re-scaffold fixture projects from upstream CLIs
```

If you already have the required env vars exported (e.g. in CI, or you don't have access to the 1Password vault), use `bun run test:e2e` directly instead. The flags are identical:

```sh
# Required env vars: CLERK_PLATFORM_API_KEY and CLERK_CLI_TEST_APP_ID
bun run test:e2e -- --filter react
```

Playwright chromium is required: `bunx playwright install chromium`

E2E test files live in `test/e2e/`, with fixture projects in `test/e2e/fixtures/`. Each test file exports a `FixtureConfig` and calls `runFixtureTest()` and `runBrowserTest()` from `test/e2e/lib/`. See `.claude/rules/e2e.md` for full details on adding fixtures and required env vars.

## Opening a pull request

1. Search for open or closed [pull requests](https://github.com/clerk/cli/pulls) that relate to your submission to avoid duplicating effort
2. Create your feature branch (`git checkout -b feat/amazing_feature`)
3. Write tests to verify your change
4. If your change affects user-facing behavior, add a changeset (`bunx changeset`)
5. Commit your changes using [conventional commits](https://www.conventionalcommits.org/) (`git commit -m 'feat: add amazing feature'`)
6. Push to the branch (`git push origin feat/amazing_feature`)
7. [Open a pull request](https://github.com/clerk/cli/compare?expand=1)

### Changesets

We use [Changesets](https://github.com/changesets/changesets) for versioning and changelog generation. When your PR changes user-facing behavior, add a changeset:

```sh
bunx changeset
```

Follow the interactive prompts to select the affected package (`clerk`) and the bump type (patch, minor, or major). Commit the generated `.changeset/*.md` file with your PR.

If your change is internal-only (CI, tests, docs, refactoring), you can skip the changeset.

For more details, see [Adding a Changeset](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md).

### Commit messages

All commit messages must follow the [conventional commits](https://www.conventionalcommits.org/) specification:

```
<type>[optional scope]: <description>
```

Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `build`, `perf`.

### Notes on pull requests

- Prefer multiple small PRs with related changes over large PRs
- Always include a description explaining what the PR does and why
- For bug fixes, include steps to reproduce the issue or a screen recording

## Issues and feature requests

Found a bug or want to suggest a feature? [Submit an issue on GitHub](https://github.com/clerk/cli/issues). Before creating an issue, search the issue archive to avoid duplicates.

## Publishing packages

_Note: Only Clerk employees can publish packages._

See [docs/releasing.md](docs/releasing.md) for the full release flow.

## License

By contributing to Clerk, you agree that your contributions will be licensed under its [MIT License](LICENSE).
