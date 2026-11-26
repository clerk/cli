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
  /** Absent when the operation takes no body, or its body declares no content type. */
  requestBody?: RequestBodyInfo;
}

export interface BodyField {
  name: string;
  /** Display type, such as `string`, `string[]`, `string | null` or `"api" | "mcp"`. */
  type: string;
  required: boolean;
  /** First line of the field's description. */
  description: string;
}

export interface RequestBodyInfo {
  contentType: string;
  required: boolean;
  /** Display type of the whole body: `object`, or `array of object` for a list of objects. */
  type: string;
  /** Top-level properties of the body, or of its items when the body is an array. */
  fields: BodyField[];
}

export interface Catalog {
  endpoints: EndpointInfo[];
  tags: string[];
  fetchedAt: number;
  /** Shape version of the cached catalog; a cache with another value is refetched. */
  format?: number;
}

/** Bump when the parsed catalog gains or changes fields, so old caches are refreshed. */
const CATALOG_FORMAT = 2;

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

type Schema = Record<string, any>;

/** How deep `$ref` chains and `allOf` nesting are followed before giving up. */
const MAX_SCHEMA_DEPTH = 20;
/** How deep `formatType` descends into items and alternatives before printing `object`. */
const MAX_TYPE_DEPTH = 10;

/** Follow local `$ref`s (`#/components/...`) until a concrete schema is reached. */
export function resolveRef(spec: Schema, schema: unknown, depth = 0): Schema {
  if (!schema || typeof schema !== "object") return {};
  const ref = (schema as Schema).$ref;
  if (typeof ref !== "string" || depth > MAX_SCHEMA_DEPTH) return schema as Schema;
  const target = ref
    .replace(/^#\//, "")
    .split("/")
    .reduce<unknown>((node, key) => (node as Schema | undefined)?.[key], spec);
  return resolveRef(spec, target, depth + 1);
}

/** Resolve a schema and merge its `allOf` parts into one set of properties and required names. */
export function flattenSchema(spec: Schema, schema: unknown, depth = 0): Schema {
  const resolved = resolveRef(spec, schema);
  if (!Array.isArray(resolved.allOf) || depth > MAX_SCHEMA_DEPTH) return resolved;
  const parts = resolved.allOf.map((part: unknown) => flattenSchema(spec, part, depth + 1));
  const merged = [...parts, { ...resolved, allOf: undefined }];
  return {
    ...Object.assign({}, ...merged),
    properties: Object.assign({}, ...merged.map((p) => p.properties ?? {})),
    required: merged.flatMap((p) => (Array.isArray(p.required) ? p.required : [])),
  };
}

/** A schema's type as `api ls` prints it, such as `string | null` or `("a" | "b")[]`. */
export function formatType(spec: Schema, schema: unknown, depth = 0): string {
  if (depth > MAX_TYPE_DEPTH) return "object";
  const s = flattenSchema(spec, schema);
  // A 3.1 type list that already has "null" doesn't need 3.0's `nullable` too.
  const typeHasNull = Array.isArray(s.type) && s.type.includes("null");
  const nullable = s.nullable === true && !typeHasNull ? " | null" : "";
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ") + nullable;
  }
  const alternatives = s.oneOf ?? s.anyOf;
  if (Array.isArray(alternatives)) {
    const types = alternatives.map((alt: unknown) => formatType(spec, alt, depth + 1));
    return [...new Set(types)].join(" | ") + nullable;
  }
  const type = Array.isArray(s.type) ? s.type.join(" | ") : s.type;
  if (type === "array") {
    const items = formatType(spec, s.items, depth + 1);
    return (items.includes(" | ") ? `(${items})[]` : `${items}[]`) + nullable;
  }
  return (type ?? (s.properties ? "object" : "any")) + nullable;
}

function bodyFields(spec: Schema, schema: Schema): BodyField[] {
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries<unknown>(schema.properties ?? {}).map(([name, prop]) => ({
    name,
    type: formatType(spec, prop),
    required: required.has(name),
    description: String(resolveRef(spec, prop).description ?? "")
      .split("\n")[0]!
      .trim(),
  }));
}

/** Summarize an operation's request body, preferring its JSON content. */
function parseRequestBody(spec: Schema, requestBody: unknown): RequestBodyInfo | undefined {
  const body = resolveRef(spec, requestBody);
  const content = (body.content ?? {}) as Record<string, { schema?: unknown }>;
  const contentType = "application/json" in content ? "application/json" : Object.keys(content)[0];
  if (!contentType) return undefined;

  const schema = flattenSchema(spec, content[contentType]?.schema);
  const isArray = schema.type === "array";
  const fieldsSchema = isArray ? flattenSchema(spec, schema.items) : schema;
  return {
    contentType,
    required: body.required === true,
    type: isArray ? `array of ${formatType(spec, schema.items)}` : formatType(spec, schema),
    fields: bodyFields(spec, fieldsSchema),
  };
}

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
        requestBody: parseRequestBody(spec, op.requestBody),
      });
    }
  }

  const tags = [...new Set(endpoints.map((e) => e.tag))].sort();
  return { endpoints, tags, fetchedAt: Date.now(), format: CATALOG_FORMAT };
}

// ── Loading ────────────────────────────────────────────────────────────────

export async function loadCatalog(options: { platform?: boolean } = {}): Promise<Catalog> {
  const platform = options.platform ?? false;

  // Check cache
  const cached = await readCache(platform);
  if (cached && cached.format === CATALOG_FORMAT && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
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
