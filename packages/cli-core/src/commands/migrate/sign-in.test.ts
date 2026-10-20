/**
 * How `migrate import` signs a person in when there are no credentials.
 *
 * On its way to `clerk link`, it signs in without login's own claim, so
 * `link` alone applies the claim rule. With `--app` it links nothing, so
 * login's own claim, and its question, stays on.
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { credentialStoreStubs } from "../../test/lib/stubs.ts";

mock.module("../../mode.ts", () => ({
  isHuman: () => true,
  isAgent: () => false,
  getMode: () => "human",
  setMode: () => {},
}));

// Signed out. Stubbed so no test reads the developer's real keychain.
mock.module("../../lib/credential-store.ts", () => ({
  ...credentialStoreStubs,
  hasAccountCredentials: async () => false,
}));

const mockLogin = mock();
mock.module("../auth/login.ts", () => ({
  login: (...args: unknown[]) => mockLogin(...args),
}));

// Stops the run right after signing in and linking: what follows isn't
// under test.
const STOP = new Error("stop after the sign-in");
const mockLink = mock(async () => {
  throw STOP;
});
mock.module("../link/index.ts", () => ({
  link: (...args: unknown[]) => mockLink(...(args as [])),
}));

const { run } = await import("./run.ts");
const { _setConfigDir } = await import("../../lib/config.ts");

const savedSecretKey = process.env.CLERK_SECRET_KEY;
const originalCwd = process.cwd();
let workDir: string;
let configDir: string;

// An empty folder with no link and no keys, and an empty config directory.
beforeEach(() => {
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-sign-in-")));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-sign-in-config-"));
  _setConfigDir(configDir);
  process.chdir(workDir);
  // An exported secret key names the import target on its own, with no sign-in.
  delete process.env.CLERK_SECRET_KEY;
  mockLogin.mockResolvedValue({ userId: "user_1", email: "jane@example.com" });
});

afterEach(() => {
  process.chdir(originalCwd);
  _setConfigDir(undefined);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
  if (savedSecretKey === undefined) delete process.env.CLERK_SECRET_KEY;
  else process.env.CLERK_SECRET_KEY = savedSecretKey;
  mockLogin.mockReset();
  mockLink.mockClear();
});

test("signing in on the way to `clerk link` leaves the claim to `link`", async () => {
  await run({ source: "clerk", input: "users.json" }).catch((error: unknown) => {
    if (error !== STOP) throw error;
  });

  expect(mockLogin).toHaveBeenCalledWith({ showNextSteps: false, claim: false });
  expect(mockLink).toHaveBeenCalledTimes(1);
});

// A person is claiming the SDK's app in the Dashboard; there is nothing to
// import into until they rerun.
test("when `clerk link` opens a claim page instead of linking, the import stops with exit 1", async () => {
  mockLink.mockResolvedValueOnce({ status: "claim_page_opened" } as never);

  await run({ source: "clerk", input: "/nonexistent/users.json" });

  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
});

test("with --app nothing is linked, so login's own claim stays on", async () => {
  await run({ source: "clerk", input: "/nonexistent/users.json", app: "app_123" }).catch(() => {});

  expect(mockLogin).toHaveBeenCalledWith({ showNextSteps: false });
  expect(mockLink).not.toHaveBeenCalled();
});
