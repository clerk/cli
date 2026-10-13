import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";

const temporary = mkdtempSync(join(tmpdir(), "clerk-effect-compiled-"));
const binary = join(temporary, "clerk");
const root = join(import.meta.dir, "../../../../../");
const cleanEnv = { ...process.env };
delete cleanEnv.CLERK_CLI_NO_SIGNAL_RERAISE;
const env = {
  ...cleanEnv,
  CLERK_CONFIG_DIR: temporary,
  CLERK_MODE: "agent",
  CLERK_PLATFORM_API_KEY: "ak_test",
  CLERK_TELEMETRY_DISABLED: "1",
  CLERK_NO_UPDATE_CHECK: "1",
};

beforeAll(() => {
  const build = Bun.spawnSync(
    [
      "bun",
      "build",
      "--compile",
      "--minify",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "packages/cli-core/src/cli.ts",
      "--outfile",
      binary,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
});
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

async function invoke(args: string[], baseUrl?: string) {
  const proc = Bun.spawn([binary, ...args], {
    env: { ...env, ...(baseUrl ? { CLERK_PLATFORM_API_URL: baseUrl } : {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

test("compiled listing parser preserves help, invalid exits and completion", async () => {
  const help = await invoke(["help", "apps", "list"]);
  expect(help.code).toBe(0);
  expect(help.out).toContain("--json");
  const invalid = await invoke(["apps", "list", "--unknown"]);
  expect(invalid.code).toBe(1);
  const complete = await invoke(["__complete", "apps", "list", "--"]);
  expect(complete.code).toBe(0);
  expect(complete.out).toContain("--json");
});

test("compiled listing uses production layers and strips secrets", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json([
        {
          application_id: "app_compiled",
          name: "Compiled",
          instances: [
            {
              instance_id: "ins_compiled",
              environment_type: "development",
              secret_key: "sk_private",
              publishable_key: "pk_private",
            },
          ],
        },
      ]),
  });
  try {
    const result = await invoke(["apps", "list", "--json"], server.url.toString());
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual([
      {
        application_id: "app_compiled",
        name: "Compiled",
        instances: [
          {
            instance_id: "ins_compiled",
            environment_type: "development",
            publishable_key: "pk_private",
          },
        ],
      },
    ]);
    expect(result.out).not.toContain("sk_private");
  } finally {
    await server.stop(true);
  }
});

test("compiled API failures retain agent output and real exit status", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json(
        { errors: [{ code: "test_failure", message: "Listing unavailable" }] },
        { status: 503 },
      ),
  });
  try {
    const result = await invoke(["apps", "list"], server.url.toString());
    expect(result.code).toBe(1);
    expect(JSON.parse(result.err).error.message).toContain("Failed to list applications (503)");
  } finally {
    await server.stop(true);
  }
});

test("compiled listing interrupted during a request dies from SIGINT", async () => {
  if (process.platform === "win32") return;
  let received!: () => void;
  const requestReceived = new Promise<void>((resolve) => {
    received = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      received();
      return new Promise<Response>(() => {});
    },
  });
  const proc = Bun.spawn([binary, "apps", "list"], {
    env: { ...env, CLERK_PLATFORM_API_URL: server.url.toString() },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => proc.kill("SIGKILL"), 10_000);
  try {
    await requestReceived;
    proc.kill("SIGINT");
    await proc.exited;
    expect(proc.signalCode).toBe("SIGINT");
  } finally {
    clearTimeout(deadline);
    proc.kill();
    await server.stop(true);
  }
}, 15_000);

test("compiled Effect route emits one sanitized telemetry event", async () => {
  const events: Array<{
    events: ReadonlyArray<{ payload: { command: string; flags: string; outcome: string } }>;
  }> = [];
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/telemetry") {
        events.push(
          Schema.decodeUnknownSync(
            Schema.Struct({
              events: Schema.Array(
                Schema.Struct({
                  payload: Schema.Struct({
                    command: Schema.String,
                    flags: Schema.String,
                    outcome: Schema.String,
                    mode: Schema.String,
                  }),
                }),
              ),
            }),
          )(await request.json()),
        );
        return new Response(null, { status: 204 });
      }
      requests++;
      return Response.json([]);
    },
  });
  try {
    const proc = Bun.spawn(
      [
        binary,
        "apps",
        "list",
        "--input-json",
        '{"json":true,"mode":"human"}',
        "--mode",
        "agent",
        "--verbose",
      ],
      {
        env: {
          ...env,
          CI: "1",
          CLERK_TELEMETRY_DISABLED: "0",
          DO_NOT_TRACK: "0",
          CLERK_PLATFORM_API_KEY: "ak_do_not_log",
          CLERK_PLATFORM_API_URL: server.url.toString(),
          CLERK_TELEMETRY_URL: new URL("/telemetry", server.url).toString(),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual([]);
    expect(requests).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.events).toHaveLength(1);
    expect(events[0]?.events[0]?.payload).toMatchObject({
      command: "apps list",
      outcome: "success",
      mode: "agent",
    });
    expect(events[0]?.events[0]?.payload.flags.split(",").sort()).toEqual([
      "json",
      "mode",
      "verbose",
    ]);
    expect(JSON.stringify(events)).not.toContain("ak_do_not_log");
  } finally {
    await server.stop(true);
  }
});

test.each(
  [
    ["--", "apps", "list", "--json"],
    ["apps", "--", "list", "--json"],
    ["apps", "list", "--", "--json"],
  ].map((args) => ({ args })),
)("compiled operand delimiter rejects flags as operands %j", async ({ args }) => {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests++;
      return Response.json([]);
    },
  });
  try {
    const result = await invoke(args, server.url.toString());
    expect(result.code).toBe(1);
    expect(result.err).toContain("too many arguments");
    expect(result.err).not.toContain("Not authenticated");
    expect(requests).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test.each(
  [
    ["--no-json"],
    ["--no-verbose"],
    ["--json", "false"],
    ["--json", "true"],
    ["--verbose", "false"],
    ["--verbose", "0"],
  ].map((flags) => ({ flags })),
)("compiled strict boolean syntax rejects before API execution %j", async ({ flags }) => {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests++;
      return Response.json([]);
    },
  });
  try {
    const result = await invoke(["apps", "list", ...flags], server.url.toString());
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      flags[0]?.startsWith("--no-") ? "unknown option" : "too many arguments",
    );
    expect(result.err).not.toContain("Not authenticated");
    expect(requests).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test.each(
  [
    ["--help", "--version"],
    ["--version", "--help"],
    ["-h", "-v"],
    ["-vh"],
    ["--no-json", "--version"],
  ].map((flags) => ({ flags })),
)(
  "compiled version retains precedence over help and invalid boolean options %j",
  async ({ flags }) => {
    const rootVersion = await invoke(["--version"]);
    const result = await invoke(["apps", "list", ...flags]);
    expect(result.code).toBe(0);
    expect(result.out).toBe(rootVersion.out);
    expect(result.err).toBe("");
  },
);

test("compiled builtin handling keeps unsupported clusters and scalar values distinct", async () => {
  const cluster = await invoke(["apps", "list", "-hv"]);
  expect(cluster.code).toBe(1);
  expect(cluster.err).toContain("unknown option '-hv'");
  const value = await invoke(["apps", "list", "--mode", "--version"]);
  expect(value.code).toBe(2);
  expect(JSON.parse(value.err).error).toMatchObject({
    code: "usage_error",
    message: 'Invalid mode "--version". Must be "human" or "agent".',
  });
  const operand = await invoke(["apps", "list", "--", "--version"]);
  expect(operand.code).toBe(1);
  expect(operand.err).toContain("too many arguments");
});
