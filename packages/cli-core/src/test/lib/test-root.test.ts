// packages/cli-core/src/test/lib/test-root.test.ts
import { test, expect } from "bun:test";
import { testRoot } from "./test-root.ts";

test("testRoot returns a fully populated Root", () => {
  const root = testRoot();
  expect(root.credentialStore).toBeDefined();
  expect(root.configStore).toBeDefined();
  expect(root.git).toBeDefined();
  expect(root.plapi).toBeDefined();
  expect(root.bapi).toBeDefined();
  expect(root.tokenExchange).toBeDefined();
  expect(root.authServer).toBeDefined();
  expect(root.pkce).toBeDefined();
  expect(root.prompts).toBeDefined();
  expect(root.mode).toBeDefined();
  expect(root.browser).toBeDefined();
  expect(root.spinner).toBeDefined();
  expect(root.log).toBeDefined();
  expect(root.env).toBeDefined();
  expect(root.environment).toBeDefined();
  expect(root.projectDetector).toBeDefined();
});

test("conservative default: credentialStore.getToken returns null", async () => {
  const root = testRoot();
  await expect(root.credentialStore.getToken()).resolves.toBeNull();
});

test("override replaces a method while preserving siblings", async () => {
  const root = testRoot({
    credentialStore: { getToken: async () => "test-token" },
  });
  await expect(root.credentialStore.getToken()).resolves.toBe("test-token");
  // Sibling methods still have their default behavior (storeToken is strict).
  await expect(root.credentialStore.storeToken("x")).rejects.toThrow(
    /credentialStore.storeToken called without override/,
  );
});

test("strict default: tokenExchange.exchangeCodeForToken throws", async () => {
  const root = testRoot();
  await expect(
    root.tokenExchange.exchangeCodeForToken({ code: "x", codeVerifier: "y", redirectUri: "z" }),
  ).rejects.toThrow(/tokenExchange.exchangeCodeForToken called without override/);
});

test("strict default: browser.open throws", async () => {
  const root = testRoot();
  await expect(root.browser.open("about:blank")).rejects.toThrow(
    /browser.open called without override/,
  );
});

test("carve-out: spinner.withSpinner calls its callback", async () => {
  const root = testRoot();
  const result = await root.spinner.withSpinner("test", async () => 42);
  expect(result).toBe(42);
});

test("carve-out: log.info is a no-op spy", () => {
  const root = testRoot();
  root.log.info("hello");
  expect(root.log.info).toHaveBeenCalledWith("hello");
});

test("conservative default: mode.isHuman returns true", () => {
  const root = testRoot();
  expect(root.mode.isHuman()).toBe(true);
  expect(root.mode.isAgent()).toBe(false);
});

test("override: mode.isHuman can be flipped to false", () => {
  const root = testRoot({ mode: { isHuman: () => false } });
  expect(root.mode.isHuman()).toBe(false);
});

test("freshness: each call returns a new root with fresh spies", () => {
  const a = testRoot();
  const b = testRoot();
  a.log.info("from a");
  expect(a.log.info).toHaveBeenCalledTimes(1);
  expect(b.log.info).toHaveBeenCalledTimes(0);
});

test("defaults: system.which throws helpful message when no binaries set", () => {
  const deps = testRoot();
  // FakeSystem.which returns null for unregistered binaries (not throw);
  // this is the documented default. Queue-backed methods throw.
  expect(deps.system.which("nonexistent")).toBeNull();
});

test("defaults: system.runInherit throws when not queued", async () => {
  const deps = testRoot();
  await expect(deps.system.runInherit(["echo"])).rejects.toThrow(/no queued runInherit/);
});

test("override: can inject a configured FakeSystem", async () => {
  const { createFakeSystem } = await import("../../lib/system.fake.ts");
  const system = createFakeSystem({ binaries: { bunx: "/usr/bin/bunx" } });
  system.queueRunInherit(0);
  const deps = testRoot({ system });
  expect(deps.system.which("bunx")).toBe("/usr/bin/bunx");
  await expect(deps.system.runInherit(["bunx", "--help"])).resolves.toBe(0);
});
