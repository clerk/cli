/**
 * Run e2e test files as individual `bun test` subprocesses with controllable concurrency.
 *
 * Each test file gets its own process, avoiding shared process state (env vars,
 * module-level singletons) that can cause flaky failures when Bun's test runner
 * runs multiple files in a single process.
 *
 * Usage:
 *   bun run scripts/run-e2e.ts                  # concurrency 1 (default)
 *   bun run scripts/run-e2e.ts --concurrency 4  # 4 at a time
 *   bun run scripts/run-e2e.ts --filter react   # only files matching "react"
 *   bun run scripts/run-e2e.ts --debug          # verbose helper logging (sets CLERK_E2E_DEBUG=1)
 *   bun run scripts/run-e2e.ts --har            # write HAR files to ./test/e2e/.har
 *   bun run scripts/run-e2e.ts --har-dir ./out  # write HAR files to a custom directory
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Glob } from "bun";

const DEFAULT_HAR_DIR = "test/e2e/.har";

const { values } = parseArgs({
  options: {
    concurrency: { type: "string", short: "c", default: "1" },
    filter: { type: "string", short: "f", default: "" },
    debug: { type: "boolean", default: false },
    har: { type: "boolean", default: false },
    "har-dir": { type: "string" },
  },
  strict: true,
});

const concurrency = parseInt(values.concurrency, 10);
if (!Number.isFinite(concurrency) || concurrency < 1) {
  console.error(`Invalid --concurrency "${values.concurrency}". Expected an integer >= 1.`);
  process.exit(1);
}
const filter = values.filter;
const debugEnabled = values.debug;

let harDir: string | undefined;
if (values.har || values["har-dir"] !== undefined) {
  harDir = resolve(values["har-dir"] ?? DEFAULT_HAR_DIR);
  mkdirSync(harDir, { recursive: true });
}

// Discover test files
const glob = new Glob("test/e2e/*.test.ts");
let files = [...glob.scanSync(".")].sort();
if (filter) {
  files = files.filter((f) => f.includes(filter));
}

if (files.length === 0) {
  console.error(`No test files found${filter ? ` matching "${filter}"` : ""}`);
  process.exit(1);
}

const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
if (debugEnabled) childEnv.CLERK_E2E_DEBUG = "1";
if (harDir) childEnv.E2E_HAR_DIR = harDir;

console.log(`Running ${files.length} e2e test files (concurrency: ${concurrency})`);
if (debugEnabled) console.log("Debug logging enabled (CLERK_E2E_DEBUG=1)");
if (harDir) console.log(`HAR output: ${harDir}`);
console.log();

interface Result {
  file: string;
  exitCode: number;
  duration: number;
}

const results: Result[] = [];
let failed = 0;

async function runTest(file: string): Promise<Result> {
  const start = Date.now();
  const name = file.replace("test/e2e/", "").replace(".test.ts", "");
  console.log(`▶ ${name}`);

  const proc = Bun.spawn(["bun", "test", file], {
    stdio: ["ignore", "inherit", "inherit"],
    env: childEnv,
  });

  const exitCode = await proc.exited;
  const duration = Date.now() - start;
  const status = exitCode === 0 ? "✓" : "✗";
  console.log(`${status} ${name} (${(duration / 1000).toFixed(1)}s)\n`);

  return { file, exitCode, duration };
}

// Run with concurrency limit
const queue = [...files];

async function worker(): Promise<void> {
  while (queue.length > 0) {
    const file = queue.shift()!;
    let result = await runTest(file);
    if (result.exitCode !== 0) {
      // Single retry for transient failures (FAPI throttling, Playwright timeouts)
      const name = file.replace("test/e2e/", "").replace(".test.ts", "");
      console.log(`↻ ${name} (retrying)\n`);
      result = await runTest(file);
    }
    results.push(result);
    if (result.exitCode !== 0) failed++;
  }
}

const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
await Promise.all(workers);

// Summary
const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
console.log("─".repeat(60));
console.log(
  `${results.length - failed} passed, ${failed} failed (${(totalDuration / 1000).toFixed(1)}s total)`,
);

if (failed > 0) {
  console.log("\nFailed:");
  for (const r of results) {
    if (r.exitCode !== 0) {
      console.log(`  ✗ ${r.file}`);
    }
  }
  process.exit(1);
}
