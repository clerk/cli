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
```

2. Install dependencies

```sh
cd cli-new
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
bun test             # Run all tests
```

### Writing tests

When changing functionality or adding new code, add or update tests to verify the new behavior. Tests use Bun's built-in test runner:

```sh
bun test
```

Check for existing `*.test.ts` files near the code you're modifying.

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
