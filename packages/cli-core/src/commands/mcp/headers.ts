/**
 * MCP 2026-07-28 request-metadata helpers, shared by the `doctor` probe and
 * the `clerk mcp run` bridge.
 *
 * The 2026-07-28 revision mirrors selected JSON-RPC body fields into HTTP
 * headers (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`) so
 * intermediaries can route without parsing bodies. Servers reject any
 * header/body mismatch with `HeaderMismatch` (-32020), which is why every
 * value here is derived from the body it accompanies, never invented.
 * Spec: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
 */

import { isRecord } from "../../lib/objects.ts";

/** Newest protocol revision the CLI speaks; used for modern-first probing. */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";

/** `_meta` keys the 2026-07-28 revision defines for per-request metadata. */
export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/**
 * JSON-RPC error codes the MCP spec reserves for itself (-32020 to -32099).
 * Receiving one proves the far side speaks a modern (2026-07-28+) revision —
 * the signal the backward-compatibility algorithm keys on before falling back
 * to a legacy `initialize`.
 */
export const MCP_ERROR_CODE = {
  HEADER_MISMATCH: -32020,
  MISSING_REQUIRED_CLIENT_CAPABILITY: -32021,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
} as const;

const MODERN_ERROR_CODES: ReadonlySet<number> = new Set(Object.values(MCP_ERROR_CODE));

/** True when a JSON-RPC error code identifies a modern (2026-07-28+) server. */
export function isModernErrorCode(code: number): boolean {
  return MODERN_ERROR_CODES.has(code);
}

// Deliberately stricter than RFC 9110 (which also allows htab): only visible
// ASCII with interior spaces travels plain; everything else — including htab
// and leading/trailing whitespace, which HTTP parsing would strip — is
// Base64-encoded. Over-encoding is always safe; under-encoding never is.
const SAFE_HEADER_VALUE = /^[\x21-\x7e][\x20-\x7e]*$/;
const BASE64_SENTINEL = /^=\?base64\?.*\?=$/;

/** True when a value can travel as a plain HTTP header value untouched. */
export function isHeaderSafe(value: string): boolean {
  return SAFE_HEADER_VALUE.test(value) && !value.endsWith(" ");
}

/**
 * Encode a value for an `Mcp-Name` or `Mcp-Param-*` header. Header-safe ASCII
 * passes through; anything else (non-ASCII, control chars, padding whitespace,
 * or a value that itself matches the sentinel pattern) is carried as
 * `=?base64?<base64 of UTF-8>?=` per the spec's Value Encoding rules.
 */
export function encodeHeaderValue(value: string): string {
  if (isHeaderSafe(value) && !BASE64_SENTINEL.test(value)) return value;
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** A tool parameter designated for header mirroring via `x-mcp-header`. */
export interface HeaderAnnotation {
  /** Name portion of the resulting `Mcp-Param-{name}` header. */
  header: string;
  /** Chain of `properties` keys locating the parameter in the arguments. */
  path: string[];
}

export type ToolAnnotationResult =
  | { ok: true; annotations: HeaderAnnotation[] }
  | { ok: false; reason: string };

// HTTP field-name token syntax (RFC 9110 `1*tchar`).
const TCHAR = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PRIMITIVE_TYPES = new Set(["string", "integer", "boolean"]);

/**
 * Collect the `x-mcp-header` annotations of a tool definition, validating the
 * spec's constraints. A single violation anywhere in the schema invalidates
 * the whole tool — the caller must exclude it from `tools/list` results, so a
 * malformed definition can't be called with silently missing headers.
 */
export function extractToolHeaderAnnotations(tool: unknown): ToolAnnotationResult {
  if (!isRecord(tool)) return { ok: false, reason: "tool is not an object" };
  const schema = tool.inputSchema;
  if (!isRecord(schema)) return { ok: true, annotations: [] };

  const annotations: HeaderAnnotation[] = [];
  const seen = new Set<string>();
  // Only chains made purely of `properties` keys are statically reachable; an
  // annotation under `items`, composition/conditional keywords, or `$ref`
  // invalidates the tool. Walk everything so those stray annotations surface.
  const walk = (node: unknown, reachable: boolean, path: string[]): string | undefined => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const problem = walk(item, false, path);
        if (problem) return problem;
      }
      return undefined;
    }
    if (!isRecord(node)) return undefined;
    if ("x-mcp-header" in node) {
      const name = node["x-mcp-header"];
      if (!reachable) return `"x-mcp-header" at an unreachable schema location`;
      if (typeof name !== "string" || name.length === 0 || !TCHAR.test(name)) {
        return `invalid "x-mcp-header" name ${JSON.stringify(name)}`;
      }
      if (seen.has(name.toLowerCase())) return `duplicate "x-mcp-header" name "${name}"`;
      if (typeof node.type !== "string" || !PRIMITIVE_TYPES.has(node.type)) {
        return `"x-mcp-header" on non-primitive type ${JSON.stringify(node.type)}`;
      }
      seen.add(name.toLowerCase());
      annotations.push({ header: name, path });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "x-mcp-header") continue;
      if (key === "properties" && reachable && isRecord(value)) {
        for (const [prop, sub] of Object.entries(value)) {
          const problem = walk(sub, true, [...path, prop]);
          if (problem) return problem;
        }
        continue;
      }
      const problem = walk(value, false, path);
      if (problem) return problem;
    }
    return undefined;
  };

  const problem = walk(schema, true, []);
  if (problem) return { ok: false, reason: problem };
  return { ok: true, annotations };
}

/**
 * Read the annotated parameter's value from `tools/call` arguments and render
 * it as a header string. Returns `undefined` (header omitted, per spec) when
 * the value is absent, `null`, or not a mirrorable primitive.
 */
export function headerValueForParam(args: unknown, path: string[]): string | undefined {
  let value: unknown = args;
  for (const key of path) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isInteger(value) && Number.isSafeInteger(value)) {
    return String(value);
  }
  return undefined;
}
