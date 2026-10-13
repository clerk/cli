# Effect application-listing spike

Status: implementation prepared for independent review. Ticket 01 remains a draft until review is accepted. This does not authorize ticket 02 or further migration.

## Scope

The normal `runProgram` entry expands input JSON before selecting a parser. Effect CLI owns `apps list` and its help; Commander owns every other command and root/group help. Commander listing metadata remains for mixed-parser help and shell completion. Shared mode, verbosity, environment initialization, error rendering, update checks, telemetry completion, and the existing SIGINT handler remain the executable lifecycle.

Listing has configuration, credential, application API, and output service layers. Methods return Effects with tagged configuration, credential, API, output, or lifecycle failures. Existing persisted configuration and credential-store operations, host-controlled HTTP, response reads, and Clack output are external boundaries. Listing does not add retries. Human output uses scoped Clack spinner and gutter resources; spinner cleanup precedes table rendering. Secret instance keys are stripped while public publishable keys remain.

The compatibility adapter retains last-value mode precedence, help aliases, leading operand delimiters, bare version output, and legacy parse-error exits. Production error causes cross the Promise entry boundary without losing Clerk's existing structured error rendering. Signals still use the original bounded flush and real SIGINT re-raise.

## Source and dependencies

Live package-registry verification selected stable `effect@4.0.4` and `@effect/platform-bun@4.0.4`, both pinned exactly. CLI lives in `effect/cli`; no separate CLI package is needed. Matching `@effect/vitest@4.0.4` exists, but is deliberately not installed: testing remains Bun for ticket 01.

APIs were verified against installed package source and upstream tag `effect@4.0.4`, commit `e17ecdbe902aa7108f775c8ab9c0ddf9f38801ab`. The tagged `LLMS.md`, CLI Command/Flag/CliConfig/CliOutput source, services/layers, and Bun platform layer were inspected. The older Effect skill's RC pin was not used.

## Acceptance evidence

Bun command tests replace configuration, credentials, API, and output through layers without module mocks. Coverage includes successful and empty human output, agent JSON and secret stripping, API failures, cancellation, last-value mode precedence, verbosity reset, and one configuration initialization. A command test combines replaced configuration/credentials with the production HTTP layer and a local server, observing one token read and one authenticated request.

Subprocess tests cover help aliases and global flag placement, root/group help, invalid flags and operands, stdin input JSON, completion of `apps list` and `--json`, and bare version output. Existing input-JSON integration tests remain regression coverage for inline/file input and explicit flag precedence. Compiled tests build the Bun executable and check production-layer success, API failure exit/output, help/completion, and `signalCode === "SIGINT"` after interrupting an active held request.

Final checks passed: `bun run format`, `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test` (3,209 pass, zero failures across 173 files), and `bun run build:compile`. Eight compiled tests pass, including real SIGINT, exactly one sanitized telemetry event, and delimiter rejection with zero API requests. Lint emits an existing unused-variable warning in unchanged `shared.ts`. The worker runtime could not bind localhost; the coordinator runtime passed all command and auth-server tests.

E2E execution was attempted by the coordinator. `bun run test:e2e:op` is blocked by unavailable 1Password desktop socket. Direct `bun run test:e2e` is blocked by missing `CLERK_PLATFORM_API_KEY` and `CLERK_CLI_TEST_APP_ID`; no production API assertions passed. Independent review and working E2E credentials remain acceptance limitations.

## Measurements

Reproducible baseline: commit `cda3bc1b090b7fac765892674b96349962dd7f4e`, Bun 1.4.3, macOS arm64, `bun run build:compile` default release flags, telemetry disabled and `CLERK_NO_UPDATE_CHECK=1`. Each startup case uses three warmups and twenty `Bun.spawnSync` samples; medians include process startup and command completion. Compiled binary size is measured in bytes.

| Metric | Baseline | Spike |
| --- | ---: | ---: |
| Compiled binary size | 73,042,034 bytes | 73,339,250 bytes |
| Compiled `--version` median | 30.423 ms | 37.366 ms |
| Compiled `apps list --help` median | 32.999 ms | 49.087 ms |
| Interpreted `apps list --help` median | 62.418 ms | 124.589 ms |

The spike adds 297,216 bytes (0.41%). Measurements were taken against the final implementation working tree, after rebuilding, with no test suite running. Startup measurements are host-dependent; no numerical acceptance threshold was agreed. Reproduce after installing dependencies and running `bun run build:compile`: `bun docs/effect-apps-list-benchmark.ts /absolute/path/to/checkout`. The same helper and environment were used for both measurements.

## Local delivery

Implementation uses the existing isolated checkout `/Users/wyatt.johnson/.codex/worktrees/b448/cli` because this worker could not write the nested checkout or shared Git worktree metadata. Integration and implementation refs use the `wyattjoh/` prefix; the local integration ref is `wyattjoh/effect-apps-list-integration`, and the implementation ref is `wyattjoh/effect-apps-list-implementation`, based on `cda3bc1b090b7fac765892674b96349962dd7f4e`. The coordinator owns the final local commits/ref updates. No push, remote issue, PR, main-branch landing, Vitest adoption, or later command migration is included.

An empty changeset records the internal refactor without announcing a new CLI feature or version bump. The full specification and original draft ticket files are unchanged.
