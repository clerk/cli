/**
 * `clerk schema` — fetch and output the OpenAPI spec for Clerk APIs.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  CLERK_CACHE_DIR,
  CACHE_TTL_MS,
  OPENAPI_SPECS,
  OPENAPI_SPECS_BASE_URL,
  OPENAPI_SPEC_ALIASES,
} from "../../lib/constants.ts";
import { CliError, throwUsageError } from "../../lib/errors.ts";
import { dim } from "../../lib/color.ts";

const API_NAMES = Object.keys(OPENAPI_SPECS);

interface OpenApiOptions {
  output?: string;
  format?: string;
  specVersion?: string;
}

/** Resolve an alias (e.g. "bapi" → "backend") or return the name as-is. */
function resolveApiName(name: string): string {
  return OPENAPI_SPEC_ALIASES[name] ?? name;
}

export async function schema(apiName: string | undefined, options: OpenApiOptions): Promise<void> {
  if (!apiName) {
    printAvailableApis();
    return;
  }

  const resolved = resolveApiName(apiName);
  const specInfo = OPENAPI_SPECS[resolved];
  if (!specInfo) {
    throwUsageError(`Unknown API "${apiName}". Available APIs: ${API_NAMES.join(", ")}`);
  }

  const version = options.specVersion ?? specInfo.latest;
  if (!specInfo.versions.includes(version)) {
    throwUsageError(
      `Unknown version "${version}" for ${resolved}. Available versions: ${specInfo.versions.join(", ")}`,
    );
  }

  const format = options.format ?? "yaml";
  if (format !== "yaml" && format !== "json") {
    throwUsageError(`Invalid format "${format}". Must be "yaml" or "json".`);
  }

  const spec = await fetchSpec(resolved, specInfo.repoDir, version);
  const output = format === "json" ? toJson(spec) : spec;

  if (options.output) {
    await Bun.write(options.output, output + "\n");
    console.error(`Spec written to ${options.output}`);
  } else {
    console.log(output);
  }
}

// ── List ─────────────────────────────────────────────────────────────────────

function printAvailableApis(): void {
  const aliases = Object.entries(OPENAPI_SPEC_ALIASES);
  console.log("Available APIs:\n");
  for (const [name, info] of Object.entries(OPENAPI_SPECS)) {
    const aka = aliases.filter(([, v]) => v === name).map(([k]) => k);
    const aliasStr = aka.length > 0 ? dim(` (alias: ${aka.join(", ")})`) : "";
    console.log(
      `  ${name.padEnd(12)} latest: ${info.latest} ${dim(`(${info.versions.length} version${info.versions.length === 1 ? "" : "s"})`)}${aliasStr}`,
    );
  }
  console.log("\nUsage: clerk schema <api> [--spec-version <version>] [--format json]");
}

// ── Caching ──────────────────────────────────────────────────────────────────

function cacheFilePath(api: string, version: string): string {
  return join(CLERK_CACHE_DIR, `openapi-${api}-${version}.yml`);
}

async function readCache(api: string, version: string): Promise<string | null> {
  try {
    const file = Bun.file(cacheFilePath(api, version));
    if (!(await file.exists())) return null;
    const stat = await file.stat();
    if (!stat || Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    return file.text();
  } catch {
    return null;
  }
}

async function writeCache(api: string, version: string, content: string): Promise<void> {
  await mkdir(CLERK_CACHE_DIR, { recursive: true });
  await Bun.write(cacheFilePath(api, version), content);
}

// ── Fetching ─────────────────────────────────────────────────────────────────

async function fetchSpec(api: string, repoDir: string, version: string): Promise<string> {
  const cached = await readCache(api, version);
  if (cached) return cached;

  const url = `${OPENAPI_SPECS_BASE_URL}/${repoDir}/${version}.yml`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    await writeCache(api, version, text);
    return text;
  } catch (error) {
    throw new CliError(
      `Unable to fetch OpenAPI spec. Check your network connection.\n` +
        `  URL: ${url}\n` +
        `  ${(error as Error).message}`,
    );
  }
}

// ── Formatting ───────────────────────────────────────────────────────────────

function toJson(yamlText: string): string {
  const parsed = parseYaml(yamlText);
  return JSON.stringify(parsed, null, 2);
}
