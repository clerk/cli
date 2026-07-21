import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { expandInputJson, toKebabCase } from "./input-json.ts";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("toKebabCase", () => {
  test("converts camelCase", () => {
    expect(toKebabCase("dryRun")).toBe("dry-run");
  });

  test("converts camelCase with no prefix", () => {
    expect(toKebabCase("noSkills")).toBe("no-skills");
  });

  test("converts snake_case", () => {
    expect(toKebabCase("dry_run")).toBe("dry-run");
  });

  test("passes through kebab-case unchanged", () => {
    expect(toKebabCase("dry-run")).toBe("dry-run");
  });

  test("handles single word", () => {
    expect(toKebabCase("yes")).toBe("yes");
  });

  test("handles multiple humps", () => {
    expect(toKebabCase("secretKeyId")).toBe("secret-key-id");
  });

  test("handles key with digits before uppercase", () => {
    expect(toKebabCase("v2Name")).toBe("v2-name");
  });

  test("lowercases all-uppercase word", () => {
    expect(toKebabCase("JSON")).toBe("json");
  });

  test("handles empty string", () => {
    expect(toKebabCase("")).toBe("");
  });
});

describe("expandInputJson", () => {
  test("returns argv unchanged when --input-json is absent", async () => {
    const argv = ["clerk", "init", "--yes"];
    const result = await expandInputJson(argv);
    expect(result).toEqual(["clerk", "init", "--yes"]);
  });

  test("leaves `mcp run` stdin untouched even when piped", async () => {
    // `mcp run` streams JSON-RPC on stdin; reaching the stdin auto-read here
    // would consume the stream. It must return unchanged without reading.
    process.stdin.isTTY = false;
    const argv = ["clerk", "mcp", "run"];
    expect(await expandInputJson(argv)).toEqual(argv);
  });

  test("bypasses `mcp run` even with global flags before the command", async () => {
    process.stdin.isTTY = false;
    const argv = ["clerk", "--mode", "agent", "mcp", "run"];
    expect(await expandInputJson(argv)).toEqual(argv);
  });

  test("does NOT bypass when `mcp run` appears only as an option value", async () => {
    // `--name mcp run` on an unrelated command must still expand --input-json.
    const argv = ["clerk", "init", "--name", "mcp", "run", "--input-json", '{"yes":true}'];
    const result = await expandInputJson(argv);
    expect(result).toEqual(["clerk", "init", "--name", "mcp", "run", "--yes"]);
  });

  test("expands string values to flags", async () => {
    const argv = ["clerk", "init", "--input-json", '{"framework":"next"}'];
    const result = await expandInputJson(argv);
    expect(result).toEqual(["clerk", "init", "--framework", "next"]);
  });

  test("expands boolean true to flag", async () => {
    const argv = ["clerk", "init", "--input-json", '{"yes":true}'];
    const result = await expandInputJson(argv);
    expect(result).toEqual(["clerk", "init", "--yes"]);
  });

  test("skips boolean false values", async () => {
    const argv = ["clerk", "init", "--input-json", '{"yes":false}'];
    const result = await expandInputJson(argv);
    expect(result).toEqual(["clerk", "init"]);
  });

  test("expands negated boolean (noX pattern)", async () => {
    const argv = ["clerk", "init", "--input-json", '{"noSkills":true}'];
    const result = await expandInputJson(argv);
    expect(result).toEqual(["clerk", "init", "--no-skills"]);
  });

  test("converts camelCase keys to kebab-case flags", async () => {
    const argv = ["clerk", "config", "patch", "--input-json", '{"dryRun":true}'];
    const result = await expandInputJson(argv);
    expect(result).toEqual(["clerk", "config", "patch", "--dry-run"]);
  });

  test("expands array values to repeated flags", async () => {
    const argv = ["clerk", "config", "pull", "--input-json", '{"keys":["a","b"]}'];
    const result = await expandInputJson(argv);
    expect(result).toEqual(["clerk", "config", "pull", "--keys", "a", "--keys", "b"]);
  });

  test("expands numeric values as strings", async () => {
    const argv = ["clerk", "test", "--input-json", '{"timeout":30}'];
    const result = await expandInputJson(argv);
    expect(result).toEqual(["clerk", "test", "--timeout", "30"]);
  });

  test("skips null and undefined values", async () => {
    const argv = ["clerk", "init", "--input-json", '{"framework":null}'];
    const result = await expandInputJson(argv);
    expect(result).toEqual(["clerk", "init"]);
  });

  test("empty JSON object is a no-op", async () => {
    const argv = ["clerk", "init", "--input-json", "{}"];
    const result = await expandInputJson(argv);
    expect(result).toEqual(["clerk", "init"]);
  });

  test("expands multiple keys", async () => {
    const argv = ["clerk", "init", "--input-json", '{"framework":"next","yes":true}'];
    const result = await expandInputJson(argv);
    expect(result).toContain("--framework");
    expect(result).toContain("next");
    expect(result).toContain("--yes");
  });

  test("preserves explicit CLI flags after --input-json", async () => {
    const argv = ["clerk", "init", "--input-json", '{"framework":"react"}', "--yes"];
    const result = await expandInputJson(argv);
    // Expanded flags come first, explicit --yes comes after
    expect(result).toEqual(["clerk", "init", "--framework", "react", "--yes"]);
  });

  test("preserves explicit CLI flags before --input-json", async () => {
    const argv = ["clerk", "init", "--yes", "--input-json", '{"framework":"next"}'];
    const result = await expandInputJson(argv);
    expect(result).toEqual(["clerk", "init", "--yes", "--framework", "next"]);
  });

  test("errors on missing value after --input-json", async () => {
    const argv = ["clerk", "init", "--input-json"];
    await expect(expandInputJson(argv)).rejects.toThrow("requires a JSON string");
  });

  test("errors on invalid JSON", async () => {
    const argv = ["clerk", "init", "--input-json", "not-json"];
    await expect(expandInputJson(argv)).rejects.toThrow("Invalid JSON");
  });

  test("errors on JSON array", async () => {
    const argv = ["clerk", "init", "--input-json", "[1,2,3]"];
    await expect(expandInputJson(argv)).rejects.toThrow("must be a JSON object");
  });

  test("errors on JSON string primitive", async () => {
    const argv = ["clerk", "init", "--input-json", '"hello"'];
    await expect(expandInputJson(argv)).rejects.toThrow("must be a JSON object");
  });

  test("errors on JSON number primitive", async () => {
    const argv = ["clerk", "init", "--input-json", "42"];
    await expect(expandInputJson(argv)).rejects.toThrow("must be a JSON object");
  });

  test("errors on JSON boolean primitive", async () => {
    const argv = ["clerk", "init", "--input-json", "true"];
    await expect(expandInputJson(argv)).rejects.toThrow("must be a JSON object");
  });

  test("errors on nested objects", async () => {
    const argv = ["clerk", "init", "--input-json", '{"session":{"lifetime":3600}}'];
    await expect(expandInputJson(argv)).rejects.toThrow("Nested objects are not supported");
  });

  test("expands empty string value", async () => {
    const argv = ["clerk", "init", "--input-json", '{"framework":""}'];
    const result = await expandInputJson(argv);
    expect(result).toEqual(["clerk", "init", "--framework", ""]);
  });

  test("expands zero numeric value", async () => {
    const argv = ["clerk", "test", "--input-json", '{"count":0}'];
    const result = await expandInputJson(argv);
    expect(result).toEqual(["clerk", "test", "--count", "0"]);
  });

  test("expands negative numeric value", async () => {
    const argv = ["clerk", "test", "--input-json", '{"offset":-10}'];
    const result = await expandInputJson(argv);
    expect(result).toEqual(["clerk", "test", "--offset", "-10"]);
  });

  test("skips empty arrays", async () => {
    const argv = ["clerk", "config", "pull", "--input-json", '{"keys":[]}'];
    const result = await expandInputJson(argv);
    expect(result).toEqual(["clerk", "config", "pull"]);
  });

  test("stringifies mixed-type array items", async () => {
    const argv = ["clerk", "test", "--input-json", '{"tags":["a",1,true]}'];
    const result = await expandInputJson(argv);
    expect(result).toEqual(["clerk", "test", "--tags", "a", "--tags", "1", "--tags", "true"]);
  });

  test("expands snake_case keys to kebab-case flags", async () => {
    const argv = ["clerk", "api", "--input-json", '{"secret_key":"sk_123"}'];
    const result = await expandInputJson(argv);
    expect(result).toEqual(["clerk", "api", "--secret-key", "sk_123"]);
  });

  test("preserves positional args alongside JSON expansion", async () => {
    const argv = ["clerk", "api", "/users", "--input-json", '{"method":"POST"}'];
    const result = await expandInputJson(argv);
    expect(result).toEqual(["clerk", "api", "/users", "--method", "POST"]);
  });

  test("does not mutate the original argv reference when called standalone", async () => {
    const original = ["clerk", "init", "--input-json", '{"yes":true}'];
    const copy = [...original];
    await expandInputJson(copy);
    // The copy IS mutated (splice), but the original is untouched
    expect(original).toEqual(["clerk", "init", "--input-json", '{"yes":true}']);
  });

  describe("@file support", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "clerk-input-json-test-"));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    test("reads JSON from a file", async () => {
      const filePath = join(tempDir, "opts.json");
      await Bun.write(filePath, '{"framework":"next","yes":true}');

      const argv = ["clerk", "init", "--input-json", `@${filePath}`];
      const result = await expandInputJson(argv);
      expect(result).toContain("--framework");
      expect(result).toContain("next");
      expect(result).toContain("--yes");
    });

    test("errors when file does not exist", async () => {
      const argv = ["clerk", "init", "--input-json", `@${tempDir}/nonexistent.json`];
      await expect(expandInputJson(argv)).rejects.toThrow("File not found");
    });

    test("errors when file contains invalid JSON", async () => {
      const filePath = join(tempDir, "bad.json");
      await Bun.write(filePath, "not valid json");

      const argv = ["clerk", "init", "--input-json", `@${filePath}`];
      await expect(expandInputJson(argv)).rejects.toThrow("Invalid JSON");
    });

    test("errors when file is empty", async () => {
      const filePath = join(tempDir, "empty.json");
      await Bun.write(filePath, "");

      const argv = ["clerk", "init", "--input-json", `@${filePath}`];
      await expect(expandInputJson(argv)).rejects.toThrow("Invalid JSON");
    });
  });

  describe("stdin support", () => {
    let tempDir: string;
    let scriptPath: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "clerk-stdin-test-"));
      scriptPath = join(tempDir, "stdin-test.ts");
      // Write a small helper script that imports expandInputJson and outputs the result.
      // The argv to expand is passed as a single JSON argument.
      await Bun.write(
        scriptPath,
        `
        import { expandInputJson } from "${join(import.meta.dir, "input-json.ts")}";
        const argv = JSON.parse(process.argv[2]);
        try {
          const result = await expandInputJson(argv);
          process.stdout.write(JSON.stringify({ result }));
        } catch (e) {
          process.stdout.write(JSON.stringify({ error: e.message }));
        }
        `,
      );
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    /**
     * Spawn a subprocess that calls expandInputJson with the given argv
     * and writes the piped JSON to its stdin. Returns the expanded argv
     * as parsed JSON.
     */
    async function expandViaStdin(
      argv: string[],
      stdinData: string,
    ): Promise<{ result?: string[]; error?: string }> {
      const proc = Bun.spawn(["bun", "run", scriptPath, JSON.stringify(argv)], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      proc.stdin.write(stdinData);
      proc.stdin.end();

      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return JSON.parse(stdout);
    }

    test("--input-json - reads from stdin", async () => {
      const result = await expandViaStdin(
        ["clerk", "init", "--input-json", "-"],
        '{"framework":"next","yes":true}',
      );
      expect(result.result).toContain("--framework");
      expect(result.result).toContain("next");
      expect(result.result).toContain("--yes");
    });

    test("ignores piped stdin when --input-json is absent", async () => {
      const result = await expandViaStdin(["clerk", "init"], '{"framework":"next","yes":true}');
      // Without an explicit --input-json -, stdin is left untouched.
      expect(result.result).toEqual(["clerk", "init"]);
    });

    test("ignores piped non-JSON stdin (shell loops, command bodies)", async () => {
      const result = await expandViaStdin(["clerk", "whoami"], "not json\nmore lines\n");
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual(["clerk", "whoami"]);
    });

    test("leaves stdin for a subcommand that claims it with a bare `-`", async () => {
      // e.g. `webhooks verify --payload -`: stdin is the payload, not input-json.
      // Without --input-json, argv is returned unchanged (no `--type` spliced in).
      const argv = ["clerk", "webhooks", "verify", "--payload", "-"];
      const result = await expandViaStdin(argv, '{"type":"user.created"}');
      expect(result.result).toEqual(argv);
    });

    test("--input-json - errors on invalid JSON from stdin", async () => {
      const result = await expandViaStdin(["clerk", "init", "--input-json", "-"], "not-json");
      expect(result.error).toContain("Invalid JSON");
    });

    test("--input-json - errors on empty stdin", async () => {
      const result = await expandViaStdin(["clerk", "init", "--input-json", "-"], "");
      expect(result.error).toContain("No JSON received on stdin");
    });

    test("ignores piped JSON array when --input-json is absent", async () => {
      const result = await expandViaStdin(["clerk", "init"], "[1,2,3]");
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual(["clerk", "init"]);
    });

    test("--input-json - handles camelCase keys", async () => {
      const result = await expandViaStdin(
        ["clerk", "config", "patch", "--input-json", "-"],
        '{"dryRun":true}',
      );
      expect(result.result).toEqual(["clerk", "config", "patch", "--dry-run"]);
    });
  });
});
