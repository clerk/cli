/**
 * Telemetry is exercised via the CLERK_TELEMETRY_URL escape hatch (tests run
 * as 0.0.0-dev, where telemetry is otherwise off). The harness mocks all
 * fetch, so events are captured from http.requests.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { clerk, http, useIntegrationTestHarness } from "./lib/harness.ts";

useIntegrationTestHarness();

const TELEMETRY_URL = "https://test-telemetry.clerk.com/v1/event";

// Isolate from ambient env: clear before each test too (not just after) so a
// pre-set CLERK_TELEMETRY_URL/CLERK_TELEMETRY_DISABLED/DO_NOT_TRACK in the
// shell can't change whether telemetry is enabled for the first test.
beforeEach(() => {
  delete process.env.CLERK_TELEMETRY_URL;
  delete process.env.CLERK_TELEMETRY_DISABLED;
  delete process.env.DO_NOT_TRACK;
});
afterEach(() => {
  delete process.env.CLERK_TELEMETRY_URL;
  delete process.env.CLERK_TELEMETRY_DISABLED;
  delete process.env.DO_NOT_TRACK;
});

function telemetryEvents() {
  const requests = http.requests.filter((r) => r.url.startsWith(TELEMETRY_URL));
  return requests.map((r) => JSON.parse(r.body ?? "{}") as { events: Record<string, any>[] });
}

test("sends one anonymous event for a successful command", async () => {
  process.env.CLERK_TELEMETRY_URL = TELEMETRY_URL;
  http.mock({ "test-telemetry.clerk.com": {} });

  await clerk("completion", "zsh");

  const bodies = telemetryEvents();
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.events).toHaveLength(1);
  const event = bodies[0]!.events[0]!;
  expect(event.sdk).toBe("clerk-cli");
  expect(event.event).toBe("CLI_COMMAND_EXECUTED");
  // Command path is subcommand NAMES only — "zsh" is an argument value and
  // is deliberately excluded (spec: "resolved command path, never raw argv").
  expect(event.payload.command).toBe("completion");
  expect(event.payload.outcome).toBe("success");
  expect(event.payload.exit_code).toBe(0);
  expect(event.payload.machine_uuid).toMatch(/^[0-9a-f-]{36}$/);
  expect(typeof event.payload.duration_ms).toBe("number");
  // Env-dependent fields are strings, values depend on the host machine.
  expect(typeof event.payload.ai_agent).toBe("string");
  expect(typeof event.payload.install_method).toBe("string");
  // Never collected: the argument value ("zsh") must not leak into any event
  // field — fails if command path or flags ever start carrying argv values.
  expect(JSON.stringify(event)).not.toContain("zsh");
});

test("records failures with error code and reuses the machine uuid", async () => {
  process.env.CLERK_TELEMETRY_URL = TELEMETRY_URL;
  http.mock({ "test-telemetry.clerk.com": {} });
  const first = await clerk("completion", "zsh");
  expect(first.exitCode).toBe(0);
  const firstUuid = telemetryEvents()[0]!.events[0]!.payload.machine_uuid;

  // `apps list` fails because its PLAPI route is not mocked (the mock fetch
  // throws) — a real error path through runProgram's catch, unlike Commander
  // usage errors (invalid .choices() values), which exit inside Commander in
  // production and never produce telemetry.
  http.mock({ "test-telemetry.clerk.com": {} });
  const result = await clerk.raw("apps", "list");
  expect(result.exitCode).toBe(1);

  const bodies = telemetryEvents();
  expect(bodies).toHaveLength(1);
  const event = bodies[0]!.events[0]!;
  expect(event.payload.command).toBe("apps list");
  expect(event.payload.outcome).toBe("error");
  expect(event.payload.exit_code).toBe(1);
  expect(event.payload.error_code).toBe("unexpected_error");
  expect(event.payload.machine_uuid).toBe(firstUuid);
});

test("maps a soft failure (process.exitCode set without throwing) to outcome error", async () => {
  process.env.CLERK_TELEMETRY_URL = TELEMETRY_URL;
  http.mock({ "test-telemetry.clerk.com": {} });

  try {
    // Simulates commands (api, deploy status, mcp, users) that report
    // failure by setting process.exitCode instead of throwing.
    process.exitCode = 1;
    await clerk.raw("completion", "zsh");

    const bodies = telemetryEvents();
    expect(bodies).toHaveLength(1);
    const event = bodies[0]!.events[0]!;
    expect(event.payload.outcome).toBe("error");
    expect(event.payload.exit_code).toBe(1);
  } finally {
    process.exitCode = undefined;
  }
});

test("command succeeds even when the telemetry endpoint is down", async () => {
  process.env.CLERK_TELEMETRY_URL = TELEMETRY_URL;
  http.mock(); // no routes: every fetch throws, including the telemetry send
  const result = await clerk.raw("completion", "zsh");
  expect(result.exitCode).toBe(0);
});

test("no telemetry traffic without CLERK_TELEMETRY_URL (dev build guard)", async () => {
  http.mock(); // guard mock: any fetch would throw
  await clerk("completion", "zsh");
  expect(http.requests).toHaveLength(0);
});
