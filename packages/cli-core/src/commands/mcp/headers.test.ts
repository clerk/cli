import { describe, expect, test } from "bun:test";
import {
  MCP_ERROR_CODE,
  encodeHeaderValue,
  extractToolHeaderAnnotations,
  headerValueForParam,
  isModernErrorCode,
  isHeaderSafe,
} from "./headers.ts";

describe("encodeHeaderValue", () => {
  test.each([
    ["us-west1", "us-west1"],
    ["file:///projects/myapp/config.json", "file:///projects/myapp/config.json"],
    ["Hello, 世界", "=?base64?SGVsbG8sIOS4lueVjA==?="],
    [" padded ", "=?base64?IHBhZGRlZCA=?="],
    ["line1\nline2", "=?base64?bGluZTEKbGluZTI=?="],
    ["=?base64?literal?=", "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?="],
  ])("encodes %j as %j", (input, expected) => {
    expect(encodeHeaderValue(input)).toBe(expected);
  });
});

describe("isHeaderSafe", () => {
  test.each([
    ["tools/call", true],
    ["server/discover", true],
    ["", false],
    ["a\nb", false],
    ["café", false],
    [" leading", false],
    ["trailing ", false],
    ["mid space ok", true],
  ])("%j -> %p", (value, expected) => {
    expect(isHeaderSafe(value)).toBe(expected);
  });
});

describe("isModernErrorCode", () => {
  test.each([
    [MCP_ERROR_CODE.HEADER_MISMATCH, true],
    [MCP_ERROR_CODE.MISSING_REQUIRED_CLIENT_CAPABILITY, true],
    [MCP_ERROR_CODE.UNSUPPORTED_PROTOCOL_VERSION, true],
    [-32601, false],
    [-32000, false],
  ])("%i -> %p", (code, expected) => {
    expect(isModernErrorCode(code)).toBe(expected);
  });
});

describe("extractToolHeaderAnnotations", () => {
  const tool = (inputSchema: unknown): unknown => ({ name: "t", inputSchema });

  test("collects annotations on top-level primitive properties", () => {
    const result = extractToolHeaderAnnotations(
      tool({
        type: "object",
        properties: {
          region: { type: "string", "x-mcp-header": "Region" },
          query: { type: "string" },
        },
      }),
    );
    expect(result).toEqual({
      ok: true,
      annotations: [{ header: "Region", path: ["region"] }],
    });
  });

  test("collects annotations on nested properties reachable via properties chains", () => {
    const result = extractToolHeaderAnnotations(
      tool({
        type: "object",
        properties: {
          options: {
            type: "object",
            properties: { tenant: { type: "string", "x-mcp-header": "Tenant" } },
          },
        },
      }),
    );
    expect(result).toEqual({
      ok: true,
      annotations: [{ header: "Tenant", path: ["options", "tenant"] }],
    });
  });

  test("a tool with no annotations is valid with none", () => {
    const result = extractToolHeaderAnnotations(
      tool({ type: "object", properties: { q: { type: "string" } } }),
    );
    expect(result).toEqual({ ok: true, annotations: [] });
  });

  test.each([
    ["empty name", { type: "string", "x-mcp-header": "" }],
    ["non-string name", { type: "string", "x-mcp-header": 7 }],
    ["invalid token chars", { type: "string", "x-mcp-header": "bad name" }],
    ["CR/LF in name", { type: "string", "x-mcp-header": "a\r\nb" }],
    ["number type", { type: "number", "x-mcp-header": "N" }],
    ["object type", { type: "object", "x-mcp-header": "O" }],
  ])("rejects the tool on %s", (_label, property) => {
    const result = extractToolHeaderAnnotations(
      tool({ type: "object", properties: { p: property } }),
    );
    expect(result.ok).toBe(false);
  });

  test("rejects duplicate names case-insensitively", () => {
    const result = extractToolHeaderAnnotations(
      tool({
        type: "object",
        properties: {
          a: { type: "string", "x-mcp-header": "Region" },
          b: { type: "string", "x-mcp-header": "region" },
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  test.each([
    ["items", { type: "array", items: { type: "string", "x-mcp-header": "X" } }],
    ["oneOf", { oneOf: [{ type: "string", "x-mcp-header": "X" }] }],
    ["anyOf", { anyOf: [{ type: "string", "x-mcp-header": "X" }] }],
    ["allOf", { allOf: [{ type: "string", "x-mcp-header": "X" }] }],
    ["not", { not: { type: "string", "x-mcp-header": "X" } }],
    ["if", { if: { type: "string", "x-mcp-header": "X" } }],
    ["$defs", { $defs: { d: { type: "string", "x-mcp-header": "X" } } }],
  ])("rejects an annotation reached through %s", (_label, property) => {
    const result = extractToolHeaderAnnotations(
      tool({ type: "object", properties: { p: property } }),
    );
    expect(result.ok).toBe(false);
  });

  test("a properties chain nested under items is not reachable", () => {
    const result = extractToolHeaderAnnotations(
      tool({
        type: "object",
        properties: {
          list: {
            type: "array",
            items: {
              type: "object",
              properties: { x: { type: "string", "x-mcp-header": "X" } },
            },
          },
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  test("a tool without an object inputSchema is valid with no annotations", () => {
    expect(extractToolHeaderAnnotations({ name: "t" })).toEqual({ ok: true, annotations: [] });
  });
});

describe("headerValueForParam", () => {
  test.each([
    [{ region: "us-west1" }, ["region"], "us-west1"],
    [{ flag: true }, ["flag"], "true"],
    [{ flag: false }, ["flag"], "false"],
    [{ n: 42 }, ["n"], "42"],
    [{ n: -7 }, ["n"], "-7"],
    [{ opts: { tenant: "acme" } }, ["opts", "tenant"], "acme"],
  ])("extracts %j at %j as %j", (args, path, expected) => {
    expect(headerValueForParam(args, path)).toBe(expected);
  });

  test.each([
    ["missing value", {}, ["region"]],
    ["null value", { region: null }, ["region"]],
    ["non-integer number", { n: 1.5 }, ["n"]],
    ["unsafe integer", { n: 2 ** 53 }, ["n"]],
    ["object value", { region: {} }, ["region"]],
    ["missing intermediate", { a: "x" }, ["a", "b"]],
    ["non-record arguments", "nope", ["a"]],
  ])("omits on %s", (_label, args, path) => {
    expect(headerValueForParam(args, path)).toBeUndefined();
  });
});
