import { test, expect, describe } from "bun:test";
import { parseEnvFile, mergeEnvVars, serializeEnvFile } from "./dotenv.ts";

describe("parseEnvFile", () => {
  test("returns empty array for empty string", () => {
    expect(parseEnvFile("")).toEqual([]);
  });

  test("parses KEY=VALUE entries", () => {
    const lines = parseEnvFile("FOO=bar\nBAZ=qux\n");
    expect(lines).toEqual([
      { type: "entry", key: "FOO", value: "bar", raw: "FOO=bar" },
      { type: "entry", key: "BAZ", value: "qux", raw: "BAZ=qux" },
    ]);
  });

  test("strips double quotes from values", () => {
    const lines = parseEnvFile('FOO="hello world"\n');
    expect(lines[0]).toEqual({
      type: "entry",
      key: "FOO",
      value: "hello world",
      raw: 'FOO="hello world"',
    });
  });

  test("strips single quotes from values", () => {
    const lines = parseEnvFile("FOO='hello world'\n");
    expect(lines[0]).toEqual({
      type: "entry",
      key: "FOO",
      value: "hello world",
      raw: "FOO='hello world'",
    });
  });

  test("preserves comments", () => {
    const lines = parseEnvFile("# This is a comment\nFOO=bar\n");
    expect(lines[0]).toEqual({ type: "comment", raw: "# This is a comment" });
  });

  test("preserves blank lines", () => {
    const lines = parseEnvFile("FOO=bar\n\nBAZ=qux\n");
    expect(lines).toEqual([
      { type: "entry", key: "FOO", value: "bar", raw: "FOO=bar" },
      { type: "blank" },
      { type: "entry", key: "BAZ", value: "qux", raw: "BAZ=qux" },
    ]);
  });

  test("handles export prefix", () => {
    const lines = parseEnvFile("export FOO=bar\n");
    expect(lines[0]).toEqual({
      type: "entry",
      key: "FOO",
      value: "bar",
      raw: "export FOO=bar",
    });
  });

  test("handles empty values", () => {
    const lines = parseEnvFile("FOO=\n");
    expect(lines[0]).toEqual({ type: "entry", key: "FOO", value: "", raw: "FOO=" });
  });

  test("handles values with equals signs", () => {
    const lines = parseEnvFile("FOO=bar=baz\n");
    expect(lines[0]).toEqual({
      type: "entry",
      key: "FOO",
      value: "bar=baz",
      raw: "FOO=bar=baz",
    });
  });
});

describe("mergeEnvVars", () => {
  test("updates existing key in-place", () => {
    const lines = parseEnvFile("A=1\nCLERK_SECRET_KEY=old\nB=2\n");
    const merged = mergeEnvVars(lines, { CLERK_SECRET_KEY: "new" });
    const output = serializeEnvFile(merged);
    expect(output).toBe("A=1\nCLERK_SECRET_KEY=new\nB=2\n");
  });

  test("appends new keys with section header", () => {
    const lines = parseEnvFile("DB_URL=postgres://localhost\n");
    const merged = mergeEnvVars(lines, {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_xxx",
      CLERK_SECRET_KEY: "sk_test_yyy",
    });
    const output = serializeEnvFile(merged);
    expect(output).toBe(
      "DB_URL=postgres://localhost\n\n# Clerk\nNEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_xxx\nCLERK_SECRET_KEY=sk_test_yyy\n",
    );
  });

  test("does not add section header when updating existing keys", () => {
    const lines = parseEnvFile("CLERK_SECRET_KEY=old\n");
    const merged = mergeEnvVars(lines, { CLERK_SECRET_KEY: "new" });
    const output = serializeEnvFile(merged);
    expect(output).toBe("CLERK_SECRET_KEY=new\n");
    expect(output).not.toContain("# Clerk");
  });

  test("preserves comments and blank lines during merge", () => {
    const input = "# Database\nDB_URL=postgres://localhost\n\n# App\nAPP_NAME=foo\n";
    const lines = parseEnvFile(input);
    const merged = mergeEnvVars(lines, { CLERK_SECRET_KEY: "sk_test" });
    const output = serializeEnvFile(merged);
    expect(output).toContain("# Database\n");
    expect(output).toContain("# App\n");
    expect(output).toContain("DB_URL=postgres://localhost\n");
  });

  test("handles empty file", () => {
    const lines = parseEnvFile("");
    const merged = mergeEnvVars(lines, { CLERK_SECRET_KEY: "sk_test" });
    const output = serializeEnvFile(merged);
    expect(output).toBe("CLERK_SECRET_KEY=sk_test\n");
  });

  test("updates one key and appends another", () => {
    const lines = parseEnvFile("CLERK_SECRET_KEY=old\n");
    const merged = mergeEnvVars(lines, {
      CLERK_SECRET_KEY: "new",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test",
    });
    const output = serializeEnvFile(merged);
    expect(output).toContain("CLERK_SECRET_KEY=new\n");
    expect(output).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test\n");
    // Should not add header since a Clerk key already existed
    expect(output).not.toContain("# Clerk");
  });
});

describe("serializeEnvFile", () => {
  test("ends with trailing newline", () => {
    const lines = parseEnvFile("FOO=bar\n");
    expect(serializeEnvFile(lines)).toBe("FOO=bar\n");
  });

  test("round-trips without modification", () => {
    const input = "# Header\nFOO=bar\n\nBAZ=qux\n";
    const lines = parseEnvFile(input);
    expect(serializeEnvFile(lines)).toBe(input);
  });
});
