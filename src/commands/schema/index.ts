/**
 * `clerk schema` — fetch and output the OpenAPI spec for Clerk APIs.
 *
 * Supports full-spec output, path-based introspection (e.g. `/users`),
 * type lookups (e.g. `User`), and `$ref` resolution.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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

interface SchemaOptions {
  output?: string;
  format?: string;
  specVersion?: string;
  resolveRefs?: boolean;
}

/** Resolve an alias (e.g. "bapi" → "backend") or return the name as-is. */
function resolveApiName(name: string): string {
  return OPENAPI_SPEC_ALIASES[name] ?? name;
}

export async function schema(
  apiName: string | undefined,
  pathOrType: string | undefined,
  options: SchemaOptions,
): Promise<void> {
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

  const rawYaml = await fetchSpec(resolved, specInfo.repoDir, version);

  // Fast path: full spec with no introspection or ref resolution
  if (!pathOrType && !options.resolveRefs) {
    const output = format === "json" ? toJson(rawYaml) : rawYaml;
    return writeOutput(output, options.output);
  }

  // Need to parse for introspection or ref resolution
  let spec = parseYaml(rawYaml);

  if (options.resolveRefs) {
    spec = resolveAllRefs(spec, spec);
  }

  let result: unknown;
  if (pathOrType) {
    result = pathOrType.startsWith("/")
      ? lookupPath(spec, pathOrType)
      : lookupType(spec, pathOrType);
  } else {
    result = spec;
  }

  const output = format === "json" ? JSON.stringify(result, null, 2) : stringifyYaml(result);
  return writeOutput(output, options.output);
}

// ── Write output ──────────────────────────────────────────────────────────────

async function writeOutput(content: string, outputPath?: string): Promise<void> {
  if (outputPath) {
    await Bun.write(outputPath, content + "\n");
    console.error(`Spec written to ${outputPath}`);
  } else {
    console.log(content);
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
  console.log("\nUsage: clerk schema <api> [path] [--spec-version <version>] [--format json]");
}

// ── Path lookup ──────────────────────────────────────────────────────────────

function lookupPath(spec: Record<string, unknown>, query: string): unknown {
  const paths = (spec.paths ?? {}) as Record<string, unknown>;
  const keys = Object.keys(paths);

  // Exact match
  if (paths[query]) {
    return { paths: { [query]: paths[query] } };
  }

  // Try common prefixes
  for (const prefix of ["/v1", "/v2"]) {
    const prefixed = prefix + query;
    if (paths[prefixed]) {
      return { paths: { [prefixed]: paths[prefixed] } };
    }
  }

  // Suffix match: find all keys ending with the query
  const suffixMatches = keys.filter((k) => k.endsWith(query));
  if (suffixMatches.length === 1) {
    return { paths: { [suffixMatches[0]]: paths[suffixMatches[0]] } };
  }
  if (suffixMatches.length > 1) {
    throwUsageError(
      `Multiple paths match "${query}":\n${suffixMatches.map((k) => `  ${k}`).join("\n")}\n\nBe more specific.`,
    );
  }

  // No match — suggest similar paths
  const suggestions = suggestSimilar(query, keys);
  const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
  throw new CliError(
    `No path "${query}" found in spec.${hint}\n\nAvailable paths (first 10):\n${keys
      .slice(0, 10)
      .map((k) => `  ${k}`)
      .join("\n")}`,
  );
}

// ── Type lookup ──────────────────────────────────────────────────────────────

function lookupType(spec: Record<string, unknown>, query: string): unknown {
  const components = spec.components as Record<string, unknown> | undefined;
  const schemas = (components?.schemas ?? {}) as Record<string, unknown>;
  const keys = Object.keys(schemas);

  // Exact match
  if (schemas[query]) {
    return { components: { schemas: { [query]: schemas[query] } } };
  }

  // Case-insensitive match
  const lowerQuery = query.toLowerCase();
  const ciMatch = keys.find((k) => k.toLowerCase() === lowerQuery);
  if (ciMatch) {
    return { components: { schemas: { [ciMatch]: schemas[ciMatch] } } };
  }

  // No match — suggest similar
  const suggestions = suggestSimilar(query, keys);
  const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
  throw new CliError(
    `No schema type "${query}" found in spec.${hint}\n\nAvailable types (first 10):\n${keys
      .slice(0, 10)
      .map((k) => `  ${k}`)
      .join("\n")}`,
  );
}

// ── Ref resolution ───────────────────────────────────────────────────────────

export function resolveAllRefs(node: unknown, root: unknown, seen?: Set<string>): unknown {
  const visited = seen ?? new Set<string>();

  if (Array.isArray(node)) {
    return node.map((el) => resolveAllRefs(el, root, visited));
  }

  if (node === null || typeof node !== "object") {
    return node;
  }

  const obj = node as Record<string, unknown>;

  if (typeof obj.$ref === "string") {
    const refPath = obj.$ref;
    if (!refPath.startsWith("#/")) return node; // external ref, skip

    if (visited.has(refPath)) {
      return { $ref: refPath, $comment: "circular reference" };
    }

    const target = walkPointer(root, refPath);
    if (target === undefined) {
      return node; // unresolvable ref, leave as-is
    }

    visited.add(refPath);
    const resolved = resolveAllRefs(target, root, visited);
    visited.delete(refPath);

    // Merge sibling properties (OpenAPI 3.1 allows description etc. next to $ref)
    const { $ref: _, ...siblings } = obj;
    if (Object.keys(siblings).length > 0) {
      return { ...(resolved as Record<string, unknown>), ...siblings };
    }
    return resolved;
  }

  // Plain object: recurse into each property
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = resolveAllRefs(value, root, visited);
  }
  return result;
}

function walkPointer(root: unknown, pointer: string): unknown {
  // "#/components/schemas/User" → ["components", "schemas", "User"]
  const segments = pointer.slice(2).split("/").map(decodeJsonPointer);
  let current: unknown = root;
  for (const seg of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

function decodeJsonPointer(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

// ── Suggestions ──────────────────────────────────────────────────────────────

function suggestSimilar(needle: string, haystack: string[], max: number = 3): string[] {
  const lower = needle.toLowerCase();

  // Substring matches first
  const substringMatches = haystack.filter((s) => s.toLowerCase().includes(lower));
  if (substringMatches.length > 0) {
    return substringMatches.slice(0, max);
  }

  // Fall back to Levenshtein distance
  const threshold = Math.ceil(needle.length / 2);
  const scored = haystack
    .map((s) => ({ s, d: levenshtein(lower, s.toLowerCase()) }))
    .filter(({ d }) => d <= threshold)
    .sort((a, b) => a.d - b.d);
  return scored.slice(0, max).map(({ s }) => s);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
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
