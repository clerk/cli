/**
 * A real Ctrl-C mid-import, in a child process.
 *
 * `CLI_SIGINT_HANDLER` exits once telemetry is flushed, before the import gets
 * back to `run()`, so nothing `run()` prints after the import reaches the
 * terminal. A test that latches the interrupt directly never runs the handler,
 * so this one sends the child a real SIGINT and reads its stderr.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let workDir: string;

beforeAll(() => {
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-sigint-")));
  fs.writeFileSync(
    path.join(workDir, "export.json"),
    JSON.stringify([{ id: "u1", primary_email_address: "a@x.dev" }]),
  );
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

test("a real Ctrl-C mid-import leaves the run ID and folder on screen", async () => {
  const source = `
    const { CLI_SIGINT_HANDLER } = await import(${JSON.stringify(`${import.meta.dir}/../../lib/signals.ts`)});
    process.on("SIGINT", CLI_SIGINT_HANDLER);
    setTimeout(() => process.exit(99), 10_000); // guard against a hang
    globalThis.fetch = async (input, init) => {
      const url = new URL(input.toString());
      const method = init?.method ?? "GET";
      if (url.pathname === "/v1/instance") {
        return Response.json({ object: "instance", id: "ins_1", environment_type: "development" });
      }
      if (url.pathname === "/v1/users/count") return Response.json({ total_count: 0 });
      if (method === "GET" && url.pathname === "/v1/users") return Response.json([]);
      if (method === "POST" && url.pathname === "/v1/users") {
        process.kill(process.pid, "SIGINT");
        return new Promise(() => {});
      }
      return new Response("unavailable", { status: 503 });
    };
    const { run } = await import(${JSON.stringify(`${import.meta.dir}/run.ts`)});
    await run({ source: "clerk", input: "export.json", yes: true, secretKey: "sk_test_x" });
  `;

  // An inherited runs-dir override would send the run somewhere this test
  // does not look.
  const {
    CLERK_CLI_NO_SIGNAL_RERAISE: _suppressed,
    CLERK_MIGRATE_DIR: _runsDir,
    ...cleanEnv
  } = process.env;
  const proc = Bun.spawn(["bun", "-e", source], {
    cwd: workDir,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...cleanEnv,
      CLERK_CONFIG_DIR: path.join(workDir, "config"),
      CLERK_MODE: "agent",
      // Never emit a real event from a test run.
      CLERK_TELEMETRY_DISABLED: "1",
    },
  });
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  expect(proc.signalCode).toBe("SIGINT");
  const [runId] = fs.readdirSync(path.join(workDir, ".clerk", "migrate"));
  expect(stderr).toContain(`Run ${runId}: ${path.join(workDir, ".clerk", "migrate", runId ?? "")}`);
}, 15_000);
