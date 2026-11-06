/**
 * Live test of a custom `clerk migrate` source against the made-up provider
 * exports from migration-test-apps' generate-custom-exports.ts, graded against their answer keys.
 *
 *   bun test-custom-source.ts -e keyhole.csv -s ./path/to/source.ts    one export
 *   bun test-custom-source.ts --all --sources-dir ./dir                every export
 *   ... --cli <path/to/cli.ts | clerk>                        a different CLI checkout, or a binary
 *   ... --out <dir>                                           write to <dir>/test-custom and <dir>/clerk-runs
 *   ... --lenient email,phone,placement,status                grade what the agent was never told as notes (lib/grade.ts Lenient)
 *   ... --expect <file>                                       { externalId: { field: value | null } } over the answer key: what an answer set changes
 *
 * --all looks in the directory for <name>-<format>.ts, then <name>.ts, per
 * export (`keyhole-csv.ts`, else `keyhole.ts`). An export with neither is
 * reported as not run.
 *
 * Per export, on a Clerk target from the pool (targets.json): check it is empty → configure Clerk for what the
 * users hold (phone, username, password; nothing required) → dry run → import
 * → grade every user → undo. The Clerk config is snapshotted first and
 * restored in a finally block.
 *
 * Writes test-results/<stamp>-custom/{report.md,report.json,log.txt}, and the
 * CLI's own runs to clerk-runs/<same>/. With --out, both go under that dir.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { clerkRun, cliVersion, DEFAULT_CLI, SetupError } from "./lib/clerk-run";
import { configForUsers, DEST_KEYS, withBaseline } from "./lib/clerk-dest";
import { grade, section, summaryLine, type AnswerKey, type Grade, type Lenient } from "./lib/grade";
import { flag, value } from "./lib/args";
import { claimTarget, targetArgs } from "./lib/targets";

const EXPORTS = ["keyhole", "passly", "gatekeep", "vaultrun", "frostline", "nimbus"].flatMap(
  (n) => [`${n}.json`, `${n}.csv`],
);
/** A cli.ts path, or a binary on PATH such as `clerk`. */
const cliFlag = value("cli")?.replace(/^~(?=\/|$)/, homedir());
const CLI = cliFlag ? (cliFlag.includes("/") ? resolve(cliFlag) : cliFlag) : DEFAULT_CLI;

// ── which exports, with which source ──

const usage =
  "Usage: bun test-custom-source.ts -e <export> -s <source.ts>   |   bun test-custom-source.ts --all --sources-dir <dir>";
let jobs: { name: string; source?: string }[];
if (flag("all")) {
  const dir = value("sourcesDir");
  if (!dir) {
    console.error(usage);
    process.exit(2);
  }
  jobs = EXPORTS.map((name) => {
    const [base, fmt] = name.split(".");
    const source = [`${base}-${fmt}.ts`, `${base}.ts`].map((f) => resolve(dir, f)).find(existsSync);
    return { name, source };
  });
} else {
  const name = value("export");
  const source = value("source");
  if (!name || !source || !EXPORTS.includes(name)) {
    console.error(`${usage}\nExports: ${EXPORTS.join(" ")}`);
    process.exit(2);
  }
  if (!existsSync(source)) {
    console.error(`No source file at ${resolve(source)}`);
    process.exit(2);
  }
  jobs = [{ name, source: resolve(source) }];
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const runName = `${stamp}-custom${jobs.length === 1 ? `-${jobs[0].name.replace(".", "-")}` : ""}`;
const out = value("out");
const runDir = out ? resolve(out, "test-custom") : resolve("test-results", runName);
const clerkRunsDir = out ? resolve(out, "clerk-runs") : resolve("clerk-runs", runName);
const CLI_VERSION = cliVersion(CLI);
const LENIENT_KEYS = ["email", "phone", "placement", "status"] as const;
const EXPECT: Record<string, Record<string, unknown>> = value("expect")
  ? JSON.parse(readFileSync(value("expect")!, "utf8"))
  : {};
const lenientArg =
  value("lenient")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? [];
const badLenient = lenientArg.filter((k) => !(LENIENT_KEYS as readonly string[]).includes(k));
if (badLenient.length) {
  console.error(`--lenient takes ${LENIENT_KEYS.join(", ")}; got ${badLenient.join(", ")}`);
  process.exit(2);
}
const LENIENT: Lenient = Object.fromEntries(lenientArg.map((k) => [k, true]));
mkdirSync(runDir, { recursive: true });
mkdirSync(clerkRunsDir, { recursive: true });
// The pool target the parent eval claimed for this run (CLERK_TARGET_NAME), else a free one.
const claim = await claimTarget(`test:custom ${jobs.map((j) => j.name).join(",")}`).catch(
  (e: Error) => {
    console.error(e.message);
    process.exit(2);
  },
);
const {
  cli,
  settledCount,
  clerkUsers,
  verifyPasswords,
  patchConfig: clerkPatch,
} = clerkRun({ cli: CLI, secretKey: claim.target.secretKey, log: join(runDir, "log.txt") });
const target = targetArgs(claim.target);
const runsDir = ["--runs-dir", clerkRunsDir];

const patchConfig = (body: object) => clerkPatch(target, body);

/**
 * Why the CLI did not create each user: the import's own record, else the dry
 * run's rejects. A source that sets no userId leaves the CLI logging rows
 * (`row-0`, …) instead of IDs; their reasons go under "*", which the grader
 * uses for any user it finds no reason for.
 */
function rejections(importRun: string | undefined, dry: any, key: AnswerKey): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of dry?.checks?.rejects ?? []) out.set(String(r.sourceId), r.reason);
  const file = importRun && join(clerkRunsDir, importRun, "users.ndjson");
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const l = JSON.parse(line);
      if (l.status !== "created") out.set(String(l.sourceId), l.reason ?? l.error ?? l.status);
    }
  }
  const ids = new Set(key.users.map((u) => u.externalId));
  const unmatched = [
    ...new Set([...out].filter(([id]) => !ids.has(id)).map(([, reason]) => reason)),
  ];
  if (unmatched.length)
    out.set(
      "*",
      `${unmatched.join(" | ")} (logged by the CLI under row numbers or other IDs, not these users' IDs)`,
    );
  return out;
}

const emptyGrade = (key: AnswerKey): Grade => ({
  ...grade(key, [], new Map(), new Set()),
  grade: "F",
});

type Result = { name: string; source?: string; grade?: Grade; error?: string; importRun?: string };

async function runOne(name: string, source: string): Promise<Result> {
  const base = name.split(".")[0];
  const key = JSON.parse(
    readFileSync(`data/custom-sources-answers/${base}.expected.json`, "utf8"),
  ) as AnswerKey;
  // An answer set can change what's right (a customer who says "ban them, don't skip them"): its overrides win.
  for (const [id, patch] of Object.entries(EXPECT)) {
    const u = key.users.find((x) => x.externalId === id) as Record<string, unknown> | undefined;
    if (!u) throw new Error(`--expect names ${id}, which ${base}'s answer key doesn't have`);
    for (const [k, v] of Object.entries(patch))
      if (v === null) delete u[k];
      else u[k] = v;
  }
  const file = resolve("data/custom-sources", name);
  const dir = join(runDir, name);
  mkdirSync(dir, { recursive: true });
  const result: Result = { name, source };
  let importRun: string | undefined;

  try {
    const existing = await settledCount();
    if (existing)
      throw new Error(
        `Clerk instance ${claim.target.name}: ${claim.target.app} ${claim.target.instance} already has ${existing} users — run bun run test:migrate-live:teardown first`,
      );
    const config = configForUsers(key.users);
    writeFileSync(join(dir, "clerk-config.json"), JSON.stringify(config, null, 2));
    await patchConfig(withBaseline(config));

    const args = [
      "migrate",
      "import",
      file,
      "--source",
      source,
      "--allow-partial",
      "--json",
      ...target,
      ...runsDir,
    ];
    const dry = await cli([...args, "--dry-run"]);
    writeFileSync(join(dir, "dry-run.json"), JSON.stringify(dry.json ?? dry.stdout, null, 2));
    if (!dry.json?.checks) {
      throw new Error(
        `dry run exited ${dry.code}: ${dry.json?.error?.message ?? dry.stderr.trim().split("\n").slice(-3).join(" ")}`,
      );
    }

    const imp = await cli([...args, "--yes"]);
    writeFileSync(join(dir, "import.json"), JSON.stringify(imp.json ?? imp.stdout, null, 2));
    importRun = imp.json?.run?.id;
    result.importRun = importRun;
    if (!imp.json?.result)
      throw new Error(`import exited ${imp.code}: ${imp.json?.error?.message ?? "no result"}`);

    // Clerk's listing lags creates; wait for it to hold what the import made.
    const created = imp.json.result.created as number;
    await settledCount(60_000, created);
    let users = await clerkUsers();
    for (let i = 0; users.length !== created && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      users = await clerkUsers();
    }
    const pw = await verifyPasswords(users, key.seedPassword);
    result.grade = grade(key, users, rejections(importRun, dry.json, key), new Set(pw.failed), {
      lenient: LENIENT,
    });
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    // A broken setup grades nothing: report it as not run, not as the source's F.
    if (error instanceof SetupError) result.error = `not run: ${result.error}`;
    else result.grade ??= emptyGrade(key);
  } finally {
    if (importRun) {
      const undo = await cli([
        "migrate",
        "undo",
        importRun,
        "--yes",
        "--json",
        ...target,
        ...runsDir,
      ]);
      const left = await settledCount().catch(() => -1);
      if (undo.code !== 0 || left !== 0) {
        const msg = `undo exited ${undo.code}, ${left} users left in the instance`;
        result.error = result.error ? `${result.error}; ${msg}` : msg;
      }
    }
  }
  if (result.error && result.grade) result.grade.grade = "F";
  return result;
}

// ── main ──

const pull = await cli(["config", "pull", ...target]);
// An expired `clerk auth login` fails here (seen mid-batch): a broken setup, not the source's F.
const pullError =
  pull.code === 0 && pull.stdout.trim()
    ? undefined
    : `not run: clerk config pull exited ${pull.code}: ${pull.stderr.trim().split("\n").pop() || "no output"}`;
const snapshot = pullError ? undefined : JSON.parse(pull.stdout);
if (snapshot)
  writeFileSync(join(runDir, "clerk-config-before.json"), JSON.stringify(snapshot, null, 2));
const results: Result[] = [];
try {
  for (const job of jobs) {
    if (pullError) {
      console.log(`${job.name.padEnd(14)} —   ${pullError}`);
      results.push({ ...job, error: pullError });
      continue;
    }
    if (!job.source) {
      console.log(`${job.name.padEnd(14)} —   not run: no source in ${value("sourcesDir")}`);
      results.push({ ...job, error: "no source file" });
      continue;
    }
    const r = await runOne(job.name, job.source);
    results.push(r);
    console.log(
      r.grade
        ? summaryLine(r.name, r.grade) + (r.error ? `   ✗ ${r.error}` : "")
        : `${r.name.padEnd(14)} —   ${r.error}`,
    );
  }
} finally {
  if (snapshot)
    await patchConfig(Object.fromEntries(DEST_KEYS.map((k) => [k, snapshot[k]]))).catch((e) =>
      console.error(`!! config restore failed: ${e.message}`),
    );
}

const pct = (g?: Grade) => (g ? `${(Math.floor(g.accuracy * 1000) / 10).toFixed(1)}%` : "");
const table = [
  "| Export | Grade | Accuracy | Users correct | Problems |",
  "|---|---|---|---|---|",
  ...results.map((r) =>
    r.grade
      ? `| ${r.name} | ${r.grade.grade} | ${pct(r.grade)} | ${r.grade.users.correct}/${r.grade.users.expected} | ${r.error ? "run failed" : r.grade.problems.length} |`
      : `| ${r.name} | — | not run | | ${r.error} |`,
  ),
].join("\n");
const sections = results
  .filter((r) => r.grade)
  .map((r) => section(r.name, r.source!, r.grade!, r.error));
writeFileSync(
  join(runDir, "report.md"),
  `# Custom source test: ${stamp}\n\nCLI: \`${CLI}\` @ ${CLI_VERSION}${lenientArg.length ? ` · lenient: ${lenientArg.join(", ")}` : ""}\n\n${table}\n\n${sections.join("\n")}`,
);
writeFileSync(
  join(runDir, "report.json"),
  JSON.stringify({ cli: CLI, cliVersion: CLI_VERSION, results }, null, 2),
);
console.log(`\nReport: ${join(runDir, "report.md")}`);
process.exitCode = results.every((r) => r.grade?.grade === "A+") ? 0 : 1;
