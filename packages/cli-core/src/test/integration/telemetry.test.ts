/**
 * Telemetry is exercised via the CLERK_TELEMETRY_URL escape hatch (tests run
 * as 0.0.0-dev, where telemetry is otherwise off). The harness mocks all
 * fetch, so events are captured from http.requests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clerk, http, useIntegrationTestHarness } from "./lib/harness.ts";
import { useCaptureLog } from "../lib/stubs.ts";

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

// The run that first shows the disclosure notice deliberately sends nothing,
// so tests that expect an event pre-mark the notice as already shown.
// Dynamic import per the harness rule: config.ts transitively imports mocked
// modules, so it must load after the harness registers its mocks.
async function markNoticeAlreadyShown() {
  const { markTelemetryNoticeShown } = await import("../../lib/config.ts");
  await markTelemetryNoticeShown();
}

test("sends one event for a successful command", async () => {
  await markNoticeAlreadyShown();
  process.env.CLERK_TELEMETRY_URL = TELEMETRY_URL;
  http.mock({ "test-telemetry.clerk.com": {} });

  await clerk("completion", "zsh");

  const bodies = telemetryEvents();
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.events).toHaveLength(1);
  const event = bodies[0]!.events[0]!;
  expect(event.sdk).toBe("clerk-cli");
  expect(event.event).toBe("CLI_COMMAND_EXECUTED");
  // Command path is subcommand names only — "zsh" is an argument value and
  // is deliberately excluded.
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
  await markNoticeAlreadyShown();
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
  await markNoticeAlreadyShown();
  process.env.CLERK_TELEMETRY_URL = TELEMETRY_URL;
  http.mock({ "test-telemetry.clerk.com": {} });

  try {
    // Simulates commands that report failure via process.exitCode instead of throwing.
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

describe("error rendering is not blocked by the telemetry send", () => {
  // Own capture buffer so the stub below can inspect stderr mid-run.
  const captured = useCaptureLog();

  test("the error is on stderr before the telemetry POST fires", async () => {
    await markNoticeAlreadyShown();
    process.env.CLERK_TELEMETRY_URL = TELEMETRY_URL;

    let stderrWhenTelemetryFired: string | null = null;
    http.stub(async (url) => {
      if (url.startsWith(TELEMETRY_URL)) {
        stderrWhenTelemetryFired = captured.err;
        return Response.json({ ok: true });
      }
      throw new Error(`Unmocked fetch route: ${url}`);
    });

    const result = await clerk.raw("apps", "list");
    expect(result.exitCode).toBe(1);
    expect(stderrWhenTelemetryFired).not.toBeNull();
    expect(stderrWhenTelemetryFired!).toContain("Unmocked fetch route");
  });
});

test("the first human run shows the notice and sends nothing; the next run sends", async () => {
  const originalCi = process.env.CI;
  delete process.env.CI; // the notice is suppressed in CI environments
  try {
    process.env.CLERK_TELEMETRY_URL = TELEMETRY_URL;
    http.mock({ "test-telemetry.clerk.com": {} });

    const first = await clerk("completion", "zsh");
    expect(first.stderr).toContain("Nothing has been sent during this run");
    expect(first.stderr).toContain("clerk telemetry disable");
    expect(telemetryEvents()).toHaveLength(0);

    const second = await clerk("completion", "zsh");
    expect(second.stderr).not.toContain("Nothing has been sent during this run");
    expect(telemetryEvents()).toHaveLength(1);
  } finally {
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
  }
});

test("`clerk telemetry disable` itself sends nothing, and the opt-out persists", async () => {
  await markNoticeAlreadyShown();
  process.env.CLERK_TELEMETRY_URL = TELEMETRY_URL;
  http.mock(); // any fetch would record and throw — none may happen

  await clerk("telemetry", "disable");
  await clerk("completion", "zsh");
  expect(http.requests).toHaveLength(0);
});

test("`clerk telemetry enable` turns events back on", async () => {
  await markNoticeAlreadyShown();
  process.env.CLERK_TELEMETRY_URL = TELEMETRY_URL;
  http.mock({ "test-telemetry.clerk.com": {} });

  await clerk("telemetry", "disable"); // sends nothing: opt-out visible at finalize
  await clerk("telemetry", "enable"); // sends: the user just opted back in
  await clerk("completion", "zsh");

  const bodies = telemetryEvents();
  expect(bodies).toHaveLength(2);
  expect(bodies[0]!.events[0]!.payload.command).toBe("telemetry enable");
  expect(bodies[1]!.events[0]!.payload.command).toBe("completion");
});

test("`clerk telemetry status` reports the state and the winning reason", async () => {
  await markNoticeAlreadyShown();
  process.env.CLERK_TELEMETRY_URL = TELEMETRY_URL; // lifts the dev-build guard
  http.mock({ "test-telemetry.clerk.com": {} });

  const enabled = await clerk("telemetry", "status");
  expect(enabled.stdout).toContain("Telemetry is enabled");

  // Broadened env parsing honored end-to-end: "yes" opts out.
  process.env.CLERK_TELEMETRY_DISABLED = "yes";
  const disabledByEnv = await clerk("telemetry", "status");
  expect(disabledByEnv.stdout).toContain("Telemetry is disabled");
  expect(disabledByEnv.stderr).toContain("CLERK_TELEMETRY_DISABLED");
  delete process.env.CLERK_TELEMETRY_DISABLED;

  await clerk("telemetry", "disable");
  const disabledByConfig = await clerk("telemetry", "status");
  expect(disabledByConfig.stdout).toContain("Telemetry is disabled");
  expect(disabledByConfig.stderr).toContain("clerk telemetry enable");
});

test("`clerk telemetry status` explains the dev-build guard", async () => {
  http.mock(); // dev build without the URL escape hatch: no network at all
  const result = await clerk("telemetry", "status");
  expect(result.stdout).toContain("Telemetry is disabled");
  expect(result.stderr).toContain("dev build");
});
