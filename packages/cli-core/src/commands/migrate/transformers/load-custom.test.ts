import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "../../../lib/errors.ts";
import { loadCustomTransformer, validateTransformer } from "./load-custom.ts";
import { __resetCustomTransformersForTesting } from "./registry.ts";

let workDir: string;
let originalCwd: string;
let counter = 0;

beforeAll(() => {
  originalCwd = process.cwd();
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-custom-")));
  process.chdir(workDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

afterEach(() => {
  __resetCustomTransformersForTesting();
});

/**
 * Writes a transformer file with a unique name.
 *
 * Names must not repeat: a dynamic `import()` caches by URL, so reusing one
 * would silently return the previous test's module.
 */
function writeTransformer(source: string, ext = "ts"): string {
  const name = `custom-${counter++}.${ext}`;
  fs.writeFileSync(path.join(workDir, name), source);
  return `./${name}`;
}

const VALID = `export default {
  key: "myplatform",
  label: "My Platform",
  description: "Exports from My Platform.",
  transformer: { account_ref: "userId", contact_email: "email" },
};`;

describe("loadCustomTransformer", () => {
  test("loads a user-authored TypeScript transformer", async () => {
    const entry = await loadCustomTransformer(writeTransformer(VALID));

    expect(entry).toMatchObject({
      key: "myplatform",
      label: "My Platform",
      transformer: { account_ref: "userId", contact_email: "email" },
    });
  });

  test("loads plain JavaScript too", async () => {
    const entry = await loadCustomTransformer(writeTransformer(VALID, "js"));
    expect(entry.key).toBe("myplatform");
  });

  // The file is the user's own code; the CLI must transpile whatever they wrote.
  test("transpiles TypeScript syntax the runtime has to strip", async () => {
    const entry = await loadCustomTransformer(
      writeTransformer(`
        interface Entry { key: string; label: string; transformer: Record<string, string> }
        const mapping = { my_id: "userId" } as const;
        const custom: Entry = { key: "tsplatform", label: "TS", transformer: { ...mapping } };
        export default custom satisfies Entry;
      `),
    );
    expect(entry.key).toBe("tsplatform");
  });

  test("carries the optional hooks through", async () => {
    const entry = await loadCustomTransformer(
      writeTransformer(`export default {
        key: "hooked", label: "Hooked",
        transformer: { id: "userId" },
        defaults: { passwordHasher: "bcrypt" },
        postTransform: (user) => { user.firstName = "set"; },
      };`),
    );

    expect(entry.defaults).toEqual({ passwordHasher: "bcrypt" });
    const user: Record<string, unknown> = {};
    entry.postTransform?.(user, {});
    expect(user.firstName).toBe("set");
  });

  test("supplies a description when the author omitted one", async () => {
    const entry = await loadCustomTransformer(
      writeTransformer(
        `export default { key: "bare", label: "Bare", transformer: { id: "userId" } };`,
      ),
    );
    expect(entry.description).toBe("Custom transformer");
  });

  test("reports a path that is not there", async () => {
    await expect(loadCustomTransformer("./nope.ts")).rejects.toThrow(/No transformer file at/);
  });

  test("reports a directory given instead of a file", async () => {
    fs.mkdirSync(path.join(workDir, "adir"), { recursive: true });
    await expect(loadCustomTransformer("./adir")).rejects.toThrow(/is a directory/);
  });

  test("reports a file that does not parse, quoting the syntax error", async () => {
    await expect(
      loadCustomTransformer(writeTransformer("export default { key: ,,, }")),
    ).rejects.toThrow(/Could not load/);
  });

  test("reports a file that throws while loading", async () => {
    await expect(
      loadCustomTransformer(writeTransformer(`throw new Error("boom"); export default {};`)),
    ).rejects.toThrow(/Could not load .*boom/s);
  });

  test("points at a named export when the default is missing", async () => {
    const file = writeTransformer(
      `export const myPlatform = { key: "x", label: "X", transformer: { a: "userId" } };`,
    );

    await expect(loadCustomTransformer(file)).rejects.toThrow(
      /has no default export.*`myPlatform`.*did you mean `export default`/s,
    );
  });

  test("reports a missing default with no named exports to suggest", async () => {
    await expect(loadCustomTransformer(writeTransformer("const unused = 1;"))).rejects.toThrow(
      /has no default export\.$/m,
    );
  });
});

describe("validateTransformer", () => {
  const valid = {
    key: "myplatform",
    label: "My Platform",
    transformer: { account_ref: "userId" },
  };

  test("accepts a minimal valid entry", () => {
    expect(validateTransformer(valid, "f.ts").key).toBe("myplatform");
  });

  test.each([
    ["a null default export", null, /is null, not an object/],
    ["a number default export", 42, /is number, not an object/],
    ["a string default export", "nope", /is string, not an object/],
  ])("rejects %s", (_label, value, expected) => {
    expect(() => validateTransformer(value, "f.ts")).toThrow(expected);
  });

  test.each([
    ["key", { ...valid, key: undefined }],
    ["key", { ...valid, key: "" }],
    ["key", { ...valid, key: "   " }],
    ["key", { ...valid, key: 7 }],
    ["label", { ...valid, label: undefined }],
    ["label", { ...valid, label: "" }],
  ])("rejects a bad %s naming the field", (field, value) => {
    expect(() => validateTransformer(value, "f.ts")).toThrow(new RegExp(`\`${field}\``));
  });

  test("rejects a non-string description", () => {
    expect(() => validateTransformer({ ...valid, description: 7 }, "f.ts")).toThrow(
      /`description` must be a string/,
    );
  });

  test.each([
    ["missing", { ...valid, transformer: undefined }],
    ["null", { ...valid, transformer: null }],
    ["an array", { ...valid, transformer: [] }],
    ["a string", { ...valid, transformer: "id" }],
  ])("rejects a transformer mapping that is %s", (_label, value) => {
    expect(() => validateTransformer(value, "f.ts")).toThrow(/`transformer`|`transformer\./);
  });

  test("names the offending entry when a mapping target is not a field name", () => {
    expect(() =>
      validateTransformer({ ...valid, transformer: { account_ref: "userId", bad: 7 } }, "f.ts"),
    ).toThrow(/`transformer.bad` must map to a Clerk field name, got number/);
  });

  // Without it the import runs to completion and creates every user with no
  // external_id — which is what makes a migration reversible.
  test("rejects a mapping with no userId target", () => {
    expect(() => validateTransformer({ ...valid, transformer: { a: "email" } }, "f.ts")).toThrow(
      /no source field maps to `userId`/,
    );
  });

  test.each([
    ["defaults", { ...valid, defaults: "nope" }],
    ["preTransform", { ...valid, preTransform: "nope" }],
    ["postTransform", { ...valid, postTransform: 7 }],
  ])("rejects a %s of the wrong type", (field, value) => {
    expect(() => validateTransformer(value, "f.ts")).toThrow(new RegExp(`\`${field}\``));
  });

  test.each([["clerk"], ["auth0"], ["supabase"]])(
    "rejects %s, which would shadow a built-in",
    (key) => {
      expect(() => validateTransformer({ ...valid, key }, "f.ts")).toThrow(
        /already a built-in transformer/,
      );
    },
  );

  test("names the file in every message, so the author knows which one", () => {
    expect(() => validateTransformer({}, "./their-file.ts")).toThrow(/\.\/their-file\.ts/);
  });

  test("raises CliError, so the global handler formats it", () => {
    expect(() => validateTransformer({}, "f.ts")).toThrow(CliError);
  });
});
