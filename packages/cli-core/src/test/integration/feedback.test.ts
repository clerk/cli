/**
 * `clerk feedback` driven through the real program: exit codes and the JSON
 * error envelope of an actual invocation, human-mode prompts, and the two
 * events one run produces. The POST is captured through CLERK_TELEMETRY_URL.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { clerk, http, mockPrompts, useIntegrationTestHarness } from "./lib/harness.ts";

const h = useIntegrationTestHarness();

const TELEMETRY_URL = "https://test-telemetry.clerk.com/v1/event";
const ISSUES_URL = "https://github.com/clerk/cli/issues";

const COMPLETE = [
  "--goal",
  "pull the dev keys",
  "--attempted",
  "ran clerk env pull",
  "--issue",
  "it wrote .env instead",
  "--outcome",
  "worked_around",
];

let originalCi: string | undefined;

beforeEach(async () => {
  delete process.env.CLERK_TELEMETRY_URL;
  delete process.env.CLERK_TELEMETRY_DISABLED;
  delete process.env.DO_NOT_TRACK;
  originalCi = process.env.CI;
  delete process.env.CI;
  // Keep the cap file out of the real cache directory.
  const { _setFeedbackCacheDir } = await import("../../commands/feedback/rate-limit.ts");
  _setFeedbackCacheDir(join(h.tempDir, "cache"));
});
afterEach(async () => {
  delete process.env.CLERK_TELEMETRY_URL;
  delete process.env.CLERK_TELEMETRY_DISABLED;
  delete process.env.DO_NOT_TRACK;
  if (originalCi === undefined) delete process.env.CI;
  else process.env.CI = originalCi;
  const { _setFeedbackCacheDir } = await import("../../commands/feedback/rate-limit.ts");
  _setFeedbackCacheDir(undefined);
  // --mode agent sets the mocked mode module's state, which the harness does
  // not reset between tests in the same file.
  const { setMode } = await import("../../mode.ts");
  setMode("human");
});

async function markNoticeAlreadyShown() {
  const { markTelemetryNoticeShown } = await import("../../lib/config.ts");
  await markTelemetryNoticeShown();
}

function events(): { event: string; payload: Record<string, any> }[] {
  return http.requests
    .filter((r) => r.url.startsWith(TELEMETRY_URL))
    .flatMap((r) => (JSON.parse(r.body ?? "{}") as { events: any[] }).events);
}

function parseJsonError(stderr: string): { code: string; message: string; examples?: unknown[] } {
  return JSON.parse(stderr).error;
}

/** Telemetry on, past the notice, endpoint mocked: the shape every send test wants. */
async function readyToSend() {
  await markNoticeAlreadyShown();
  process.env.CLERK_TELEMETRY_URL = TELEMETRY_URL;
  http.mock({ "test-telemetry.clerk.com": {} });
}

describe("agent mode through the real program", () => {
  test.each([
    ["plain", []],
    ["with --dry-run", ["--dry-run"]],
  ])("a missing required field is exit 2 with the JSON envelope, %s", async (_label, extra) => {
    process.env.CLERK_TELEMETRY_DISABLED = "1";
    const result = await clerk.raw("--mode", "agent", "feedback", "--goal", "x", ...extra);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    const error = parseJsonError(result.stderr);
    expect(error.code).toBe("usage_error");
    expect(error.message).toBe("Missing required options: --attempted, --issue, --outcome.");
    expect(error.examples?.length).toBeGreaterThan(0);
  });

  test("an invalid --outcome is exit 2 with the JSON envelope, not Commander's plain text", async () => {
    const result = await clerk.raw("--mode", "agent", "feedback", ...COMPLETE, "--outcome", "nope");
    expect(result.exitCode).toBe(2);
    expect(parseJsonError(result.stderr).code).toBe("usage_error");
  });

  test("one run yields CLI_FEEDBACK then CLI_COMMAND_EXECUTED for `feedback`, both from clerk-cli", async () => {
    await readyToSend();
    const result = await clerk("--mode", "agent", "feedback", ...COMPLETE);
    const output = JSON.parse(result.stdout);
    expect(output.sent).toBe(true);

    const sent = events();
    expect(sent.map((e) => e.event)).toEqual(["CLI_FEEDBACK", "CLI_COMMAND_EXECUTED"]);
    expect(sent[0]!.payload.report_id).toBe(output.report_id);
    expect(sent[1]!.payload.command).toBe("feedback");
    // Flag names only on the usage event (the global --mode included), never the values.
    expect(sent[1]!.payload.flags).toBe("goal,attempted,issue,outcome,mode");
    expect(JSON.stringify(sent[1])).not.toContain("pull the dev keys");
    for (const r of http.requests) {
      expect((JSON.parse(r.body ?? "{}") as { events: { sdk: string }[] }).events[0]!.sdk).toBe(
        "clerk-cli",
      );
    }
  });

  test("an opted-out run prints sent: false with the issues URL and exits 0", async () => {
    await markNoticeAlreadyShown();
    process.env.CLERK_TELEMETRY_URL = TELEMETRY_URL;
    process.env.CLERK_TELEMETRY_DISABLED = "1";
    http.mock(); // any fetch would record and throw
    const result = await clerk("--mode", "agent", "feedback", ...COMPLETE);
    expect(JSON.parse(result.stdout)).toEqual({
      sent: false,
      reason: "telemetry_disabled",
      fallback: ISSUES_URL,
    });
    expect(http.requests).toHaveLength(0);
  });

  test("--command lands as the usage-event spelling: prefix dropped, default child, trailing arguments dropped", async () => {
    await readyToSend();
    await clerk("--mode", "agent", "feedback", ...COMPLETE, "--command", "clerk users list");
    await clerk("--mode", "agent", "feedback", ...COMPLETE, "--command", "apps list");
    await clerk("--mode", "agent", "feedback", ...COMPLETE, "--command", "clerk deploy");
    await clerk("--mode", "agent", "feedback", ...COMPLETE, "--command", "users list --limit 5");
    const feedbackEvents = events().filter((e) => e.event === "CLI_FEEDBACK");
    expect(feedbackEvents.map((e) => e.payload.command)).toEqual([
      "users list",
      "apps list",
      "deploy run",
      "users list",
    ]);
    // Nothing after the command name is ever sent.
    expect(JSON.stringify(feedbackEvents)).not.toContain("--limit");
  });

  test("--input-json carries the long fields", async () => {
    await readyToSend();
    const report = {
      goal: "g",
      attempted: "a".repeat(3000),
      issue: "i",
      outcome: "blocked",
      errorCode: "not_linked",
    };
    const result = await clerk(
      "--mode",
      "agent",
      "feedback",
      "--input-json",
      JSON.stringify(report),
    );
    expect(JSON.parse(result.stdout).sent).toBe(true);
    const payload = events()[0]!.payload;
    expect(payload.attempted).toHaveLength(3000);
    expect(payload.error_code).toBe("not_linked");
  });
});

describe("human mode", () => {
  test("prompts for every missing required field, previews, confirms, then sends", async () => {
    await readyToSend();
    mockPrompts.input("pull the dev keys");
    mockPrompts.editor("ran clerk env pull");
    mockPrompts.select("blocked");
    mockPrompts.editor("it wrote .env instead");
    mockPrompts.confirm(true);

    const result = await clerk("feedback");
    expect(result.stderr).toContain("This is exactly what will be sent:");
    expect(result.stderr).toMatch(/Sent\. Thank you\. Report id: [0-9a-f-]{36}/);
    const preview = JSON.parse(result.stdout);
    expect(preview.sdk).toBe("clerk-cli");
    expect(preview.payload.goal).toBe("pull the dev keys");
    expect(preview.payload.outcome).toBe("blocked");

    const sent = events();
    expect(sent.map((e) => e.event)).toEqual(["CLI_FEEDBACK", "CLI_COMMAND_EXECUTED"]);
    // "This is exactly what will be sent" is literal: the previewed object is the event posted.
    expect(sent[0]).toEqual(preview);
  });

  test("--yes skips only the confirmation; the preview still prints and is what is sent", async () => {
    await readyToSend();
    const result = await clerk("feedback", ...COMPLETE, "--yes");
    const preview = JSON.parse(result.stdout);
    expect(preview.payload.goal).toBe("pull the dev keys");
    expect(result.stderr).toContain("Sent. Thank you.");
    const sent = events();
    expect(sent.map((e) => e.event)).toEqual(["CLI_FEEDBACK", "CLI_COMMAND_EXECUTED"]);
    expect(sent[0]).toEqual(preview);
  });

  test("declining the confirmation sends no feedback event and exits 0", async () => {
    await readyToSend();
    mockPrompts.confirm(false);
    const result = await clerk.raw("feedback", ...COMPLETE);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Sent.");
    expect(events().map((e) => e.event)).toEqual(["CLI_COMMAND_EXECUTED"]);
    expect(events()[0]!.payload.outcome).toBe("abort");
  });

  test("--dry-run prompts for missing fields, prints the full event, and sends no feedback event", async () => {
    await readyToSend();
    mockPrompts.input("g");
    mockPrompts.editor("a");
    mockPrompts.select("worked_around");
    mockPrompts.editor("i");
    const result = await clerk("feedback", "--dry-run");
    const { sdk, payload } = JSON.parse(result.stdout);
    expect(sdk).toBe("clerk-cli");
    expect(payload.report_id).toBe("<assigned when sent>");
    expect(payload.outcome).toBe("worked_around");
    expect(result.stderr).toContain("Dry run: no report was sent.");
    expect(result.stderr).toContain("A real run would send this report now.");
    expect(events().map((e) => e.event)).toEqual(["CLI_COMMAND_EXECUTED"]);
  });

  test("an opted-out run is told before any prompt", async () => {
    await markNoticeAlreadyShown();
    process.env.CLERK_TELEMETRY_URL = TELEMETRY_URL;
    process.env.DO_NOT_TRACK = "1";
    http.mock();
    // No prompts queued: an unexpected prompt fails the test.
    const result = await clerk("feedback");
    expect(result.stderr).toContain("Telemetry is disabled on this machine");
    expect(result.stderr).toContain(ISSUES_URL);
    expect(http.requests).toHaveLength(0);
  });

  test("a capped run is told before any prompt", async () => {
    await readyToSend();
    const { recordFeedbackSend } = await import("../../commands/feedback/rate-limit.ts");
    const { FEEDBACK_DAILY_LIMIT } = await import("../../lib/constants.ts");
    // Ascending timestamps: each record prunes what is dated after it.
    const base = Date.now() - 10_000;
    for (let i = 0; i < FEEDBACK_DAILY_LIMIT; i++) {
      await recordFeedbackSend({ sentAt: base + i, command: null, errorCode: null });
    }
    const result = await clerk("feedback");
    expect(result.stderr).toContain("which is the limit");
    expect(result.stderr).toContain(ISSUES_URL);
    expect(events().map((e) => e.event)).toEqual(["CLI_COMMAND_EXECUTED"]);
  });

  test("an invalid --outcome is exit 2 with plain text", async () => {
    const result = await clerk.raw("feedback", ...COMPLETE, "--outcome", "nope");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Invalid --outcome "nope"');
    expect(result.stderr).not.toContain('"code"');
  });
});

// A fresh config dir, as the harness gives every test: the machine has never
// run the CLI.
describe("first run", () => {
  test("a real send shows the feedback notice variant and yields both events", async () => {
    process.env.CLERK_TELEMETRY_URL = TELEMETRY_URL;
    http.mock({ "test-telemetry.clerk.com": {} });
    const result = await clerk("--mode", "agent", "feedback", ...COMPLETE);
    expect(JSON.parse(result.stdout).sent).toBe(true);
    expect(result.stderr).toContain("The Clerk CLI collects usage telemetry");
    expect(result.stderr).toContain(
      "This run sends the feedback report you asked for and one usage event for this command.",
    );
    expect(result.stderr).not.toContain("Nothing has been sent during this run");
    expect(events().map((e) => e.event)).toEqual(["CLI_FEEDBACK", "CLI_COMMAND_EXECUTED"]);
  });

  test("a --dry-run shows the standard notice from the ordinary flush and yields no event", async () => {
    process.env.CLERK_TELEMETRY_URL = TELEMETRY_URL;
    http.mock(); // any fetch would record and throw
    const result = await clerk("--mode", "agent", "feedback", ...COMPLETE, "--dry-run");
    const out = JSON.parse(result.stdout);
    expect(out.would_send).toBe(true);
    expect(out.event.payload.report_id).toBe("<assigned when sent>");
    expect(result.stderr).toContain("Nothing has been sent during this run");
    expect(result.stderr).not.toContain("This run sends the feedback report");
    expect(http.requests).toHaveLength(0);
  });
});

describe("help", () => {
  test("`clerk feedback --help` names the three triggers and the rules", async () => {
    // Under the harness Commander's help signal is an error `runProgram`
    // catches (production exits 0 inside Commander), so only stdout is checked.
    const result = await clerk.raw("feedback", "--help");
    // The help is word-wrapped at 80 columns; compare on one line.
    const help = result.stdout.replace(/\s+/g, " ");
    expect(help).toContain("Usage: clerk feedback [options]");
    expect(help).toContain("exited 0 but did something other than what you expected");
    expect(help).toContain("confusing or wrong");
    expect(help).toContain("capability you needed is missing");
    expect(help).toContain("--dry-run");
    expect(help).toContain("telemetry opt-out");
    expect(help).toContain("scrubbed before it leaves your machine, on a best-effort basis");
    expect(help).toContain(
      "a pasted command line is fine: global flags before the command are skipped",
    );
    expect(help).toContain(
      "It misses values that span lines, structured config files such as YAML and pretty-printed JSON, passwords with spaces, and Markdown formatting around a label, so never include secrets",
    );
  });

  // The help text and the command's README name the same attached fields: a
  // reader of either learns everything the envelope carries.
  test.each([
    ["a random machine id"],
    ["CLI version"],
    ["install method"],
    ["detected AI agent"],
    ["terminal"],
    ["mode"],
    ["OS"],
    ["architecture"],
    ["CI flag"],
    ["tmux and screen flags"],
    ["environment name"],
    ["workspace and app ids when a project is linked"],
  ])("`clerk feedback --help` names the attached field: %s", async (phrase) => {
    const result = await clerk.raw("feedback", "--help");
    expect(result.stdout.replace(/\s+/g, " ")).toContain(phrase);
  });

  // What a dry run may write, said exactly, so nobody reads "dry run" as
  // "touches nothing", and what it does not predict.
  test("`clerk feedback --help` says exactly what a dry run writes", async () => {
    const result = await clerk.raw("feedback", "--help");
    const help = result.stdout.replace(/\s+/g, " ");
    expect(help).toContain(
      "With telemetry off, a dry run writes no machine id, notice flag or rate-limit record.",
    );
    expect(help).toContain(
      "In agent mode, the sandbox check every command that reads the config runs may still create the config directory and write and delete a temporary file there.",
    );
    expect(help).toContain(
      "whether a real run would send it now (the telemetry opt-out and the rate limit), and send no report. A real run can still fail to write the local config file.",
    );
    expect(help).toContain(
      "With telemetry on, it may create the config directory and the machine id.",
    );
    expect(help).not.toContain("to check that a real run could record the notice");
  });

  test("`clerk feedback --help` states the per-field input ceiling", async () => {
    const result = await clerk.raw("feedback", "--help");
    expect(result.stdout.replace(/\s+/g, " ")).toContain("1,000,000 characters");
  });
});
