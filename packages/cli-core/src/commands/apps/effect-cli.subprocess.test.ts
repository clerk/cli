import { expect, test } from "bun:test";

const cli = `${import.meta.dir}/../../cli.ts`;
const env = {
  ...process.env,
  CLERK_TELEMETRY_DISABLED: "1",
  CLERK_NO_UPDATE_CHECK: "1",
  CLERK_MODE: "agent",
};
async function run(args: readonly string[], stdin?: string) {
  const proc = Bun.spawn(["bun", cli, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

test.each(
  [
    ["apps", "list", "--help"],
    ["help", "apps", "list"],
    ["--mode", "agent", "apps", "list", "--help"],
    ["apps", "--mode=agent", "list", "--help"],
    ["apps", "list", "--input-json", '{"json":true}', "--help"],
  ].map((args) => ({ args })),
)("listing help is discoverable through %j", async ({ args }) => {
  const result = await run(args);
  expect(result.code).toBe(0);
  expect(result.out).toContain("List your Clerk applications");
  expect(result.out).toContain("--json");
  expect(result.err).not.toContain("ERROR");
});

test.each(
  [
    ["apps", "list", "--unknown"],
    ["apps", "list", "extra"],
    ["apps", "list", "--", "--json"],
    ["--mode", "apps", "list"],
  ].map((args) => ({ args })),
)("invalid invocation exits unsuccessfully %j", async ({ args }) => {
  const result = await run(args);
  expect(result.code).toBe(1);
  expect(result.err).toMatch(/error|ERROR|Unknown|Unrecognized/i);
});

test("root and group help remain discoverable with coexistence", async () => {
  const root = await run(["--help", "apps", "list"]);
  expect(root.code).toBe(0);
  expect(root.out).toContain("Clerk CLI");
  expect(root.out).toContain("whoami");
  const group = await run(["apps", "--help"]);
  expect(group.code).toBe(0);
  expect(group.out).toContain("create");
  expect(group.out).toContain("list");
});

test.each(
  [
    ["apps", ""],
    ["apps", "list", "--"],
  ].map((args) => ({ args })),
)("completion exposes migrated commands and flags %j", async ({ args }) => {
  const result = await run(["__complete", ...args]);
  expect(result.code).toBe(0);
  expect(result.out).toContain(args.length === 2 ? "list" : "--json");
});

test("stdin input JSON expands before Effect routing", async () => {
  const result = await run(
    ["apps", "list", "--input-json", "-", "--help"],
    '{"json":true,"mode":"agent"}',
  );
  expect(result.code).toBe(0);
  expect(result.out).toContain("List your Clerk applications");
});

test.each(["--version", "-v"])(
  "listing %s preserves the bare root version output",
  async (flag) => {
    const root = await run([flag]);
    const listing = await run(["apps", "list", flag]);
    expect(listing.code).toBe(0);
    expect(listing.out).toBe(root.out);
  },
);

test("listing boolean flags retain Commander rejection of assigned values", async () => {
  const result = await run(["apps", "list", "--json=false"]);
  expect(result.code).toBe(1);
  expect(result.err).toContain("unknown option '--json=false'");
});

test.each([{ args: ["apps", "list", "--", "--json"] }, { args: ["apps", "--", "list", "--json"] }])(
  "literal operands after delimiter are rejected before API execution %j",
  async ({ args }) => {
    const result = await run(args);
    expect(result.code).toBe(1);
    expect(result.err).toContain("too many arguments for 'list'");
    expect(result.err).not.toContain("auth_required");
  },
);
