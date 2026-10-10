#!/usr/bin/env bun
/**
 * Audits the checked-in e2e fixture lockfiles for known advisories.
 *
 * The fixtures are regenerated on a schedule by `refresh-e2e-fixtures.ts`,
 * which pulls whatever the upstream scaffolders currently resolve to. That is
 * a few thousand lockfile entries per refresh, far past what anyone reviews by
 * reading the diff, so the advisory check runs here instead of by eye.
 *
 * Every fixture directory holding a `package-lock.json` is audited, so this
 * tracks what is actually committed rather than what the manifest lists.
 *
 * Usage:
 *   bun run scripts/audit-e2e-fixtures.ts                  # markdown report, always exits 0
 *   bun run scripts/audit-e2e-fixtures.ts --fail-on high   # exit 1 if any high/critical found
 *   bun run scripts/audit-e2e-fixtures.ts --json           # raw findings for further processing
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const FIXTURES_DIR = join(import.meta.dir, "../test/e2e/fixtures");

const SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;
type Severity = (typeof SEVERITIES)[number];

const MAX_TITLES_PER_ROW = 3;

type Advisory = {
  fixture: string;
  name: string;
  severity: Severity;
  range: string;
  titles: string[];
};

type NpmAuditVia = { title?: string; url?: string; severity?: string };
type NpmAuditVulnerability = { severity?: string; range?: string; via?: (string | NpmAuditVia)[] };
type NpmAuditReport = {
  vulnerabilities?: Record<string, NpmAuditVulnerability>;
  error?: { summary?: string };
};

function isSeverity(value: string | undefined): value is Severity {
  return SEVERITIES.includes(value as Severity);
}

function atLeast(severity: Severity, floor: Severity): boolean {
  return SEVERITIES.indexOf(severity) >= SEVERITIES.indexOf(floor);
}

async function findFixtureDirs(): Promise<string[]> {
  const entries = await readdir(FIXTURES_DIR, { withFileTypes: true });
  const dirs: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!(await Bun.file(join(FIXTURES_DIR, entry.name, "package-lock.json")).exists())) continue;
    dirs.push(entry.name);
  }

  return dirs.sort();
}

async function auditFixture(fixture: string): Promise<Advisory[]> {
  const proc = Bun.spawn(["npm", "audit", "--package-lock-only", "--json"], {
    cwd: join(FIXTURES_DIR, fixture),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  // `npm audit` exits non-zero whenever it finds anything, so the exit code
  // says nothing about whether the run itself worked. Parse failure does.
  let report: NpmAuditReport;
  try {
    report = JSON.parse(stdout) as NpmAuditReport;
  } catch {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`npm audit produced no JSON for ${fixture}:\n${stderr || stdout}`);
  }

  if (report.error) {
    throw new Error(`npm audit failed for ${fixture}: ${report.error.summary ?? "unknown error"}`);
  }

  const advisories: Advisory[] = [];
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
    const severity = isSeverity(vulnerability.severity) ? vulnerability.severity : "info";
    const titles = (vulnerability.via ?? [])
      .filter((via): via is NpmAuditVia => typeof via === "object" && via !== null)
      .map((via) => (via.url ? `[${via.title}](${via.url})` : (via.title ?? "")))
      .filter(Boolean);

    advisories.push({ fixture, name, severity, range: vulnerability.range ?? "*", titles });
  }

  return advisories;
}

function renderMarkdown(advisories: Advisory[], floor: Severity): string {
  const notable = advisories
    .filter((advisory) => atLeast(advisory.severity, floor))
    .sort(
      (a, b) =>
        SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) ||
        a.fixture.localeCompare(b.fixture) ||
        a.name.localeCompare(b.name),
    );

  if (notable.length === 0) {
    return `No \`${floor}\`-or-above advisories in the fixture lockfiles.`;
  }

  const rows = notable.map((advisory) => {
    // Direct dependencies carry their own advisory titles; a package listed
    // only because something above it is vulnerable has none of its own.
    // A long-unpatched package can accumulate dozens, which turns one table
    // cell into the whole report, so the tail is collapsed to a count.
    const shown = advisory.titles.slice(0, MAX_TITLES_PER_ROW);
    const hidden = advisory.titles.length - shown.length;
    if (hidden > 0) shown.push(`_…and ${hidden} more_`);
    const detail = shown.length > 0 ? shown.join("<br>") : "_transitive_";
    return `| \`${advisory.fixture}\` | \`${advisory.name}\` | ${advisory.severity} | \`${advisory.range}\` | ${detail} |`;
  });

  return [
    `**${notable.length} \`${floor}\`-or-above ${notable.length === 1 ? "advisory" : "advisories"} in the fixture lockfiles.**`,
    "",
    "| Fixture | Package | Severity | Vulnerable range | Advisory |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "fail-on": { type: "string" },
      json: { type: "boolean", default: false },
      floor: { type: "string", default: "high" },
    },
    strict: true,
  });

  const floor = values.floor;
  if (!isSeverity(floor)) {
    console.error(`--floor must be one of: ${SEVERITIES.join(", ")}`);
    process.exit(1);
  }

  const failOn = values["fail-on"];
  if (failOn !== undefined && !isSeverity(failOn)) {
    console.error(`--fail-on must be one of: ${SEVERITIES.join(", ")}`);
    process.exit(1);
  }

  const fixtures = await findFixtureDirs();
  if (fixtures.length === 0) {
    console.error(`No fixture lockfiles found under ${FIXTURES_DIR}`);
    process.exit(1);
  }

  const advisories = (await Promise.all(fixtures.map(auditFixture))).flat();

  if (values.json) {
    console.log(JSON.stringify(advisories, null, 2));
  } else {
    console.log(renderMarkdown(advisories, floor));
  }

  if (failOn && advisories.some((advisory) => atLeast(advisory.severity, failOn))) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}

export { atLeast, renderMarkdown, SEVERITIES };
export type { Advisory, Severity };
