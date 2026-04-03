/**
 * Run test files as individual `bun test` subprocesses with controllable concurrency.
 *
 * Each test file gets its own process, avoiding shared process state (env vars,
 * module-level singletons, mock.module leaks) between test files.
 *
 * Usage:
 *   bun run scripts/run-tests.ts --pattern "**\/*.test.ts"
 *   bun run scripts/run-tests.ts --pattern "**\/*.test.ts" --exclude "test/e2e/**"
 *   bun run scripts/run-tests.ts --pattern "test/e2e/*.test.ts" --concurrency 4 --retries 1
 *   bun run scripts/run-tests.ts --pattern "**\/*.test.ts" --filter auth
 */

import { parseArgs } from "node:util";
import { availableParallelism } from "node:os";
import { Glob } from "bun";

const defaultConcurrency = String(availableParallelism());

const { values } = parseArgs({
  options: {
    pattern: { type: "string", short: "p", multiple: true, default: [] },
    exclude: { type: "string", short: "e", multiple: true, default: [] },
    concurrency: { type: "string", short: "c", default: defaultConcurrency },
    filter: { type: "string", short: "f", default: "" },
    retries: { type: "string", short: "r", default: "0" },
  },
  strict: true,
});

if (values.pattern.length === 0) {
  console.error("At least one --pattern is required.");
  process.exit(1);
}

const concurrency = parseInt(values.concurrency, 10);
if (!Number.isFinite(concurrency) || concurrency < 1) {
  console.error(`Invalid --concurrency "${values.concurrency}". Expected an integer >= 1.`);
  process.exit(1);
}

const retries = parseInt(values.retries, 10);
if (!Number.isFinite(retries) || retries < 0) {
  console.error(`Invalid --retries "${values.retries}". Expected an integer >= 0.`);
  process.exit(1);
}

// Discover test files from all patterns
const seen = new Set<string>();
for (const pattern of values.pattern) {
  for (const file of new Glob(pattern).scanSync({ cwd: "." })) {
    seen.add(file);
  }
}

// Apply exclude patterns
const excludeGlobs = values.exclude.map((p) => new Glob(p));
let files = [...seen].filter((f) => !excludeGlobs.some((g) => g.match(f))).sort();

// Apply string filter
const filter = values.filter;
if (filter) {
  files = files.filter((f) => f.includes(filter));
}

if (files.length === 0) {
  console.error(`No test files found${filter ? ` matching "${filter}"` : ""}.`);
  process.exit(1);
}

console.log(`Running ${files.length} test files (concurrency: ${concurrency})\n`);

// -------------------------------------------------------------------
// Runner
// -------------------------------------------------------------------

const streaming = concurrency === 1;

interface Result {
  file: string;
  exitCode: number;
  duration: number;
  output: string;
}

function formatName(file: string): string {
  return file.replace(/\.test\.ts$/, "");
}

async function runTest(file: string): Promise<Result> {
  const start = Date.now();
  const name = formatName(file);

  if (streaming) {
    console.log(`▶ ${name}`);
  }

  const proc = Bun.spawn(["bun", "test", file], {
    stdio: ["ignore", streaming ? "inherit" : "pipe", streaming ? "inherit" : "pipe"],
  });

  let output = "";
  if (!streaming) {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    output = stdout + stderr;
  }

  const exitCode = await proc.exited;
  const duration = Date.now() - start;
  const status = exitCode === 0 ? "✓" : "✗";

  if (streaming) {
    console.log(`${status} ${name} (${(duration / 1000).toFixed(1)}s)\n`);
  } else {
    console.log(`${status} ${name} (${(duration / 1000).toFixed(1)}s)`);
  }

  return { file, exitCode, duration, output };
}

const results: Result[] = [];
let failed = 0;
const queue = [...files];

async function worker(): Promise<void> {
  while (queue.length > 0) {
    const file = queue.shift()!;
    let result = await runTest(file);

    for (let attempt = 0; attempt < retries && result.exitCode !== 0; attempt++) {
      console.log(
        `↻ ${formatName(file)} (retry ${attempt + 1}/${retries})${streaming ? "\n" : ""}`,
      );
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
console.log("\n" + "─".repeat(60));
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

  // Print captured output for failed tests
  if (!streaming) {
    for (const r of results) {
      if (r.exitCode !== 0 && r.output) {
        console.log(`\n${"─".repeat(60)}\n${r.file}\n${"─".repeat(60)}`);
        console.log(r.output);
      }
    }
  }

  process.exit(1);
}
