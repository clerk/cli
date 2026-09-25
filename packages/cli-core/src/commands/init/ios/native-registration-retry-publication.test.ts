import { afterEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const writeFile = fs.writeFile;
let interruptWrite = true;
mock.module("node:fs/promises", () => ({
  ...fs,
  writeFile: async (...args: Parameters<typeof writeFile>) => {
    if (interruptWrite && String(args[0]).endsWith(".tmp")) {
      await writeFile(args[0], '{"schemaVersion":', args[2]);
      throw Object.assign(new Error("simulated full disk"), { code: "ENOSPC" });
    }
    return writeFile(...args);
  },
}));
const { createIOSNativeRegistrationRetryStore } = await import("./native-registration-retry.ts");
const roots: string[] = [];
afterEach(async () => {
  mock.restore();
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

test("a partial temporary write never publishes a corrupt retry record", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "clerk-retry-publish-"));
  roots.push(root);
  const store = createIOSNativeRegistrationRetryStore(() => root);
  const identity = {
    applicationId: "app_test",
    instanceId: "ins_test",
    bundleIdentifier: "com.example.MyApp",
    appIdPrefix: "ABCDE12345",
  };
  await expect(store.getOrCreate(identity)).rejects.toThrow("simulated full disk");
  expect(await fs.readdir(join(root, "idempotency"))).toEqual([]);
  interruptWrite = false;
  const key = await store.getOrCreate(identity);
  expect(await store.getOrCreate(identity)).toBe(key);
  const [file] = await fs.readdir(join(root, "idempotency"));
  expect(file).toEndWith(".json");
  expect(
    JSON.parse(await fs.readFile(join(root, "idempotency", file!), "utf8")).idempotencyKey,
  ).toBe(key);
});
