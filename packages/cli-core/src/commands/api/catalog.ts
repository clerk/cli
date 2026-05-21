/**
 * OpenAPI spec catalog: fetching, parsing, caching, and querying.
 * Used by `clerk api ls` and the interactive request builder.
 */

import { parse as parseYaml } from "yaml";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CLERK_CACHE_DIR, CACHE_TTL_MS, OPENAPI_SPEC_URLS } from "../../lib/constants.ts";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { loggedFetch } from "../../lib/fetch.ts";
import { withHomeFsAccess } from "../../lib/host-execution.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";

// ── Types ──────────────────────────────────────────────────────────────────

export interface PathParam {
  name: string;
  description: string;
}

export interface EndpointInfo {
  method: string;
  path: string;
  summary: string;
  tag: string;
  operationId: string;
  pathParams: PathParam[];
  hasRequestBody: boolean;
}

export interface Catalog {
  endpoints: EndpointInfo[];
  tags: string[];
  fetchedAt: number;
}

// ── Test helper ────────────────────────────────────────────────────────────

let overrideCacheDir: string | undefined;

/** Test-only: override the cache directory. Pass undefined to reset. */
export function _setCacheDir(dir: string | undefined): void {
  overrideCacheDir = dir;
}

function cacheDir(): string {
  return overrideCacheDir ?? CLERK_CACHE_DIR;
}

function cacheFilePath(platform: boolean): string {
  return join(cacheDir(), platform ? "plapi-catalog.json" : "bapi-catalog.json");
}

// ── Cache I/O ──────────────────────────────────────────────────────────────

async function readCache(platform: boolean): Promise<Catalog | null> {
  const path = cacheFilePath(platform);
  return withHomeFsAccess(
    { operation: "read", target: path, label: "CLI cache directory" },
    async () => {
      try {
        const file = Bun.file(path);
        if (!(await file.exists())) return null;
        const data = await file.json();
        return data as Catalog;
      } catch {
        return null;
      }
    },
  );
}

async function writeCache(platform: boolean, catalog: Catalog): Promise<void> {
  const path = cacheFilePath(platform);
  await withHomeFsAccess(
    { operation: "write", target: path, label: "CLI cache directory" },
    async () => {
      await mkdir(cacheDir(), { recursive: true });
      await Bun.write(path, JSON.stringify(catalog));
    },
  );
}

// ── Spec parsing ───────────────────────────────────────────────────────────

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Parse an OpenAPI YAML string into a Catalog. Pure function, no I/O. */
export function parseSpec(yamlText: string): Catalog {
  const spec = parseYaml(yamlText);
  const endpoints: EndpointInfo[] = [];

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    const pathObj = pathItem as Record<string, unknown>;

    for (const method of HTTP_METHODS) {
      const operation = pathObj[method];
      if (!operation || typeof operation !== "object") continue;

      const op = operation as Record<string, unknown>;
      const tag = ((op.tags as string[]) ?? ["Other"])[0] ?? "Other";

      // Merge path-level and operation-level parameters
      const allParams = [
        ...((pathObj.parameters as unknown[]) ?? []),
        ...((op.parameters as unknown[]) ?? []),
      ];
      const pathParams: PathParam[] = allParams
        .filter((p: any) => p.in === "path")
        .map((p: any) => ({ name: p.name, description: p.description ?? "" }));

      endpoints.push({
        method: method.toUpperCase(),
        path,
        summary: (op.summary as string) ?? "",
        tag,
        operationId: (op.operationId as string) ?? "",
        pathParams,
        hasRequestBody: !!op.requestBody,
      });
    }
  }

  const tags = [...new Set(endpoints.map((e) => e.tag))].sort();
  return { endpoints, tags, fetchedAt: Date.now() };
}

// ── Loading ────────────────────────────────────────────────────────────────

export async function loadCatalog(options: { platform?: boolean } = {}): Promise<Catalog> {
  const platform = options.platform ?? false;

  // Check cache
  const cached = await readCache(platform);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  // Fetch spec
  const url = platform ? OPENAPI_SPEC_URLS.platform : OPENAPI_SPEC_URLS.bapi;
  try {
    const catalog = await withSpinner("Fetching API catalog...", async () => {
      const response = await loggedFetch(url, { tag: "api-catalog" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const yamlText = await response.text();
      const parsed = parseSpec(yamlText);
      await writeCache(platform, parsed);
      return parsed;
    });
    return catalog;
  } catch (error) {
    // Fall back to stale cache
    if (cached) {
      log.warn("Unable to refresh API catalog, using cached version");
      return cached;
    }
    throw new CliError(
      `Unable to fetch API catalog. Check your network connection.\n` +
        `  URL: ${url}\n` +
        `  ${(error as Error).message}`,
      { code: ERROR_CODE.CATALOG_ERROR },
    );
  }
}

// ── Querying ───────────────────────────────────────────────────────────────

export function filterEndpoints(catalog: Catalog, keyword?: string): EndpointInfo[] {
  if (!keyword) return catalog.endpoints;

  const lower = keyword.toLowerCase();
  return catalog.endpoints.filter(
    (e) =>
      e.path.toLowerCase().includes(lower) ||
      e.summary.toLowerCase().includes(lower) ||
      e.tag.toLowerCase().includes(lower) ||
      e.operationId.toLowerCase().includes(lower),
  );
}

export function endpointsByTag(catalog: Catalog): Map<string, EndpointInfo[]> {
  const map = new Map<string, EndpointInfo[]>();
  for (const tag of catalog.tags) {
    map.set(tag, []);
  }
  for (const endpoint of catalog.endpoints) {
    const list = map.get(endpoint.tag);
    if (list) {
      list.push(endpoint);
    } else {
      map.set(endpoint.tag, [endpoint]);
    }
  }
  return map;
}
