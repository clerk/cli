/**
 * Enforces the post-DI testing pattern:
 *
 *  - Every test file under `packages/cli-core/src/commands/**` must import
 *    `testRoot` from `src/test/lib/test-root.ts` (unit tests for ported
 *    commands use testRoot(), not mock.module()).
 *
 *  - Every test file under `packages/cli-core/src/commands/**` must NOT call
 *    `mock.module(`. Ported commands read collaborators through `deps.*` and
 *    override them at call sites via `testRoot({ ... })`.
 *
 * An explicit allowlist carves out the handful of legitimate exceptions:
 *  - Files that unit-test the underlying collaborator modules themselves
 *    (for example `src/lib/credential-store.test.ts`).
 *  - Files where the mocked module is intentionally outside the deps
 *    registry (for example `@inquirer/prompts` in api interactive/index
 *    tests and `lib/autolink.ts` in link tests).
 *  - The integration scenarios fixture itself, which owns the remaining
 *    `mock.module()` entries for credential-store and git pending their
 *    downstream refactors.
 *
 * Runs fast (one glob walk plus a regex per file) and has no dependencies
 * beyond `Bun.Glob`. Wire into `bun run lint` via the root `package.json`.
 */

import { Glob } from "bun";

interface Violation {
  file: string;
  kind: "uses-mock-module" | "missing-test-root-import";
  message: string;
}

const COMMANDS_GLOB = "packages/cli-core/src/commands/**/*.test.ts";

const MOCK_MODULE_ALLOWLIST = new Set<string>([
  // api subcommands mock @inquirer/prompts directly (not yet in deps.prompts).
  "packages/cli-core/src/commands/api/index.test.ts",
  "packages/cli-core/src/commands/api/interactive.test.ts",
  // link helpers mock lib/autolink.ts (not in the deps registry per spec).
  "packages/cli-core/src/commands/link/index.test.ts",
  "packages/cli-core/src/commands/link/helpers/link-if-needed.test.ts",
]);

const TEST_ROOT_EXEMPT = new Set<string>([
  // Pure function tests with no collaborators. Still live under commands/*
  // but exercise logic that takes no deps (e.g. parseSpec, format helpers).
  "packages/cli-core/src/commands/api/bapi.test.ts",
  "packages/cli-core/src/commands/doctor/helpers/context.test.ts",
  "packages/cli-core/src/commands/init/scan.test.ts",
  // installSkills's unit test exercises buildSkillsArgs and SpawnFn stubbing
  // without needing testRoot; the command-level integration happens through
  // init/index.test.ts which does use testRoot.
  "packages/cli-core/src/commands/init/skills.test.ts",
  // bootstrap-registry.test.ts tests BOOTSTRAP_REGISTRY (pure data), not
  // any command or collaborator. It has no deps surface so testRoot would
  // be inappropriate.
  "packages/cli-core/src/commands/init/bootstrap-registry.test.ts",
]);

// Directory prefixes whose test files are exempt from the testRoot rule.
// Use prefixes for whole directories of pure-logic tests so individual new
// files do not need to update this script.
const TEST_ROOT_EXEMPT_PREFIXES = [
  // The completion command is intentionally not DI-ported. Per the design
  // spec: "completion is not in the migration plan. It stays as plain code
  // with no deps parameter."
  "packages/cli-core/src/commands/completion/",
  // Framework detection tests exercise pure heuristics over file contents
  // fed in from fixtures. No collaborators involved.
  "packages/cli-core/src/commands/init/frameworks/",
];

async function main(): Promise<void> {
  const violations: Violation[] = [];

  for await (const file of new Glob(COMMANDS_GLOB).scan({ cwd: "." })) {
    const source = await Bun.file(file).text();

    if (/\bmock\.module\s*\(/.test(source) && !MOCK_MODULE_ALLOWLIST.has(file)) {
      violations.push({
        file,
        kind: "uses-mock-module",
        message:
          "mock.module() is not allowed in command test files. Ported commands use " +
          "testRoot({ ... }) from test/lib/test-root.ts. If this file has a legitimate " +
          "exception (e.g. mocking a module outside the deps registry), add it to the " +
          "MOCK_MODULE_ALLOWLIST in scripts/check-testing-patterns.ts with a comment " +
          "explaining why.",
      });
    }

    // Accept both static (`import ... from "..."`) and dynamic
    // (`await import("...")`) forms. Some command tests have to use dynamic
    // import because they register a file-top mock.module for a non-deps
    // module (see link/*) and dynamic import sequences correctly after the
    // mock registration.
    const importsTestRoot = /test\/lib\/test-root(?:\.ts)?["']/.test(source);
    const isPrefixExempt = TEST_ROOT_EXEMPT_PREFIXES.some((prefix) => file.startsWith(prefix));
    if (!importsTestRoot && !TEST_ROOT_EXEMPT.has(file) && !isPrefixExempt) {
      violations.push({
        file,
        kind: "missing-test-root-import",
        message:
          "Command test files must import testRoot from test/lib/test-root.ts. " +
          "If this file only exercises pure functions and legitimately needs no deps, " +
          "add it to TEST_ROOT_EXEMPT in scripts/check-testing-patterns.ts.",
      });
    }
  }

  if (violations.length === 0) {
    console.log("check-testing-patterns: OK");
    return;
  }

  console.error(`check-testing-patterns: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    console.error(`  [${v.kind}] ${v.file}`);
    console.error(`    ${v.message}\n`);
  }
  process.exitCode = 1;
}

await main();
