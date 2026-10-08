/**
 * An export run's file checked again after the import's last read of it.
 *
 * Its own file because `mock.module` lasts for the file: this one swaps in a
 * provider read that overwrites the export, as a concurrent export to a shared
 * `--output` path would between the user load and the provider read.
 */

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { credentialStoreStubs, useCaptureLog } from "../../test/lib/stubs.ts";
import * as providers from "./lib/supabase-providers.ts";

let exportFile = "";

mock.module("../../lib/credential-store.ts", () => credentialStoreStubs);
mock.module("./lib/supabase-providers.ts", () => ({
  ...providers,
  readSupabaseRows: async () => {
    const envelope = JSON.parse(fs.readFileSync(exportFile, "utf-8"));
    fs.writeFileSync(exportFile, JSON.stringify({ ...envelope, users: [] }));
    return [];
  },
}));

const { _setConfigDir } = await import("../../lib/config.ts");
const { sha256File, startRun } = await import("./lib/run-store.ts");
const { run } = await import("./run.ts");

useCaptureLog();

let workDir: string;
let configDir: string;
let originalCwd: string;
const originalFetch = globalThis.fetch;
const creates: string[] = [];

beforeAll(() => {
  originalCwd = process.cwd();
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-recheck-")));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-recheck-config-"));
  _setConfigDir(configDir);
  process.chdir(workDir);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    if (url.pathname === "/v1/instance") {
      return Response.json({ object: "instance", id: "ins_1", environment_type: "development" });
    }
    if (url.pathname === "/v1/users/count") return Response.json({ total_count: 0 });
    if (url.pathname === "/v1/users" && init?.method === "POST") {
      creates.push(url.pathname);
      return Response.json({ id: "user_created" });
    }
    if (url.pathname === "/v1/users") return Response.json([]);
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  _setConfigDir(undefined);
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

test("refuses an export overwritten between the user load and the provider read", async () => {
  const exportRun = startRun(path.join(workDir, ".clerk", "migrate"), {
    kind: "export",
    target: { platform: "supabase" },
    source: "supabase",
  });
  exportFile = path.join(exportRun.dir, "export.json");
  fs.writeFileSync(
    exportFile,
    JSON.stringify({
      clerkMigrate: 1,
      source: "supabase",
      exportedAt: "2026-09-01T00:00:00.000Z",
      runId: exportRun.record.id,
      users: [{ id: "s1", email: "a@x.dev", email_confirmed_at: "2024-01-01" }],
    }),
  );
  exportRun.update({ file: { path: exportFile, sha256: sha256File(exportFile) } });
  exportRun.finish();

  await expect(
    run({ input: exportRun.record.id, yes: true, secretKey: "sk_test_x" }),
  ).rejects.toThrow(/has changed since it was exported/);
  expect(creates).toEqual([]);
});
