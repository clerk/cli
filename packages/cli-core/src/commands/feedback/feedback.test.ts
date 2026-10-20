/**
 * Agent-mode behaviour of the handler, with the POST captured through
 * CLERK_TELEMETRY_URL. Tests have no TTY, so the mode resolves to agent.
 * Human-mode prompts and the exit codes of a real invocation are covered by
 * the integration test (`src/test/integration/feedback.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgram } from "../../cli-program.ts";
import * as config from "../../lib/config.ts";
import * as hostExecution from "../../lib/host-execution.ts";
import { _resetInterruptState, beginInterrupt } from "../../lib/signals.ts";
import * as telemetry from "../../lib/telemetry.ts";
import { CURRENT_VERSION } from "../../lib/version.ts";
import {
  _setConfigDir,
  ensureMachineUuid,
  markTelemetryNoticeShown,
  readConfig,
  setTelemetryDisabled,
} from "../../lib/config.ts";
import { FEEDBACK_DAILY_LIMIT, GITHUB_ISSUES_URL } from "../../lib/constants.ts";
import { CliError, EXIT_CODE } from "../../lib/errors.ts";
import { setLogLevel } from "../../lib/log.ts";
import * as prompts from "../../lib/prompts.ts";
import { EMAIL_MARKER, REDACTED } from "../../lib/redact.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import {
  ATTACHED_FIELD_PHRASES,
  FEEDBACK_EVENT,
  feedback,
  resolveCommand,
  type CommandTree,
  type FeedbackOptions,
  type FeedbackResult,
} from "./feedback.ts";
import { _setFeedbackCacheDir, recordFeedbackSend } from "./rate-limit.ts";

const CAPTURE_URL = "https://capture.invalid/v1/event";
const program = createProgram();

const COMPLETE: FeedbackOptions = {
  goal: "pull the dev keys",
  attempted: "ran clerk env pull and expected .env.local",
  issue: "it wrote .env instead",
  outcome: "worked_around",
};

type Posted = {
  url: string;
  body: { events: { event: string; payload: Record<string, unknown> }[] };
};

let configDir: string;
let posted: Posted[];
let respondWith: () => Response | Promise<Response>;
const originalFetch = globalThis.fetch;
const originalCi = process.env.CI;
const captured = useCaptureLog();

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "clerk-feedback-test-"));
  _setConfigDir(configDir);
  _setFeedbackCacheDir(join(configDir, "cache"));
  delete process.env.CLERK_TELEMETRY_URL;
  delete process.env.CLERK_TELEMETRY_DISABLED;
  delete process.env.DO_NOT_TRACK;
  delete process.env.CI;
  posted = [];
  respondWith = () => new Response("{}");
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    if (String(url) !== CAPTURE_URL) throw new Error(`unexpected fetch ${String(url)}`);
    posted.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
    return respondWith();
  }) as unknown as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  _setConfigDir(undefined);
  _setFeedbackCacheDir(undefined);
  delete process.env.CLERK_TELEMETRY_URL;
  delete process.env.CLERK_TELEMETRY_DISABLED;
  delete process.env.DO_NOT_TRACK;
  if (originalCi === undefined) delete process.env.CI;
  else process.env.CI = originalCi;
  setLogLevel("info");
  await rm(configDir, { recursive: true, force: true });
});

/** Past the first-run notice and with the dev-build guard lifted: the shape every send test wants. */
async function readyToSend(): Promise<void> {
  await markTelemetryNoticeShown();
  process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
}

async function run(options: FeedbackOptions): Promise<FeedbackResult> {
  await feedback(options, program);
  return JSON.parse(captured.out.trim().split("\n").at(-1)!) as FeedbackResult;
}

/** The handler's usage error, as `runProgram` would render it: exit 2 with examples. */
async function usageErrorOf(options: FeedbackOptions): Promise<CliError> {
  try {
    await feedback(options, program);
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    const cliError = error as CliError;
    expect(cliError.exitCode).toBe(EXIT_CODE.USAGE);
    expect(cliError.code).toBe("usage_error");
    expect(cliError.examples?.length).toBeGreaterThan(0);
    return cliError;
  }
  throw new Error("expected a usage error");
}

const feedbackEvents = () =>
  posted.flatMap((p) => p.body.events).filter((e) => e.event === FEEDBACK_EVENT);

/** Record `count` earlier sends with ascending timestamps (each record prunes what is dated after it). */
async function recordSends(count: number): Promise<void> {
  const base = Date.now() - 10_000;
  for (let i = 0; i < count; i++) {
    await recordFeedbackSend({ sentAt: base + i, command: null, errorCode: null });
  }
}

describe("resolveCommand", () => {
  // The result must be a name usage events record (`commandPathOf` in
  // telemetry.ts): the command whose action ran. Verified against the real
  // tree: `deploy` and `open` are the only groups with a default child;
  // `impersonate` is the only group with its own argument; `users` runs a
  // menu when bare.
  test.each([
    ["users list", "users list"],
    ["clerk users list", "users list"],
    ["  clerk   users   list  ", "users list"],
    ["feedback", "feedback"],
    // A group with a default child is recorded as that child.
    ["deploy", "deploy run"],
    ["clerk deploy", "deploy run"],
    ["deploy run", "deploy run"],
    ["open", "open dashboard"],
    // A word that is not a subcommand is the default child's argument.
    ["open users", "open dashboard"],
    // ...but only when the default child takes an argument. `deploy run` takes
    // none, so `clerk deploy statsu` fails in Commander and no usage event
    // carries it; a typo there must not be recorded as a real `deploy run`.
    ["deploy statsu", null],
    // A group with its own argument is recorded as itself.
    ["impersonate user_123", "impersonate"],
    // A group that runs a menu when bare is a real command name.
    ["users", "users"],
    // Arguments and flags after a leaf are dropped (they are never sent).
    ["users list --limit 5", "users list"],
    ["clerk users open user_123", "users open"],
    ["deploy status extra words", "deploy status"],
    // A flag stops the walk.
    ["users --json list", "users"],
    // A typo under a group is still an error.
    ["users lst", null],
    ["nope", null],
    ["users nope", null],
    // A bare group that runs nothing on its own never appears in usage events.
    ["auth", null],
    ["apps", null],
    ["clerk env", null],
    // Leading global flags are not parsed (documented).
    ["--mode agent users list", null],
    ["", null],
    ["clerk", null],
    // `clerk help <command>` is real, though Commander answers it before any
    // usage event starts; it is recorded as typed, for any existing command.
    ["help", "help"],
    ["help users", "help users"],
    ["clerk help users list", "help users list"],
    ["help deploy", "help deploy"],
    ["help nosuch", null],
    ["help users nope", null],
  ])("%j → %j", (input, expected) => {
    expect(resolveCommand(program, input).path).toBe(expected);
  });

  test("a bare group's usage error names its subcommands", async () => {
    const error = await usageErrorOf({ ...COMPLETE, command: "auth" });
    expect(error.message).toContain('"auth" runs nothing on its own');
    expect(error.message).toContain("auth login");
    expect(error.message).toContain("auth logout");
  });

  test("an alias resolves to the canonical name", () => {
    const leaf: CommandTree = {
      name: () => "list",
      aliases: () => ["ls"],
      commands: [],
      parent: null,
    };
    const group: CommandTree = {
      name: () => "users",
      aliases: () => [],
      commands: [leaf],
      parent: null,
    };
    const root: CommandTree = {
      name: () => "clerk",
      aliases: () => [],
      commands: [group],
      parent: null,
    };
    expect(resolveCommand(root, "users ls").path).toBe("users list");
  });
});

// The help text is built from the same list, so this pins the README to it: a
// reader of either learns every field the envelope attaches.
describe("the README names every attached field the help text names", () => {
  const readme = Bun.file(join(import.meta.dir, "README.md")).text();
  test.each(ATTACHED_FIELD_PHRASES.map((phrase) => [phrase]))("%s", async (phrase) => {
    expect(await readme).toContain(phrase);
  });
});

describe("validation happens before any gating", () => {
  test.each([
    ["invalid --outcome", { ...COMPLETE, outcome: "gave_up" }, 'Invalid --outcome "gave_up"'],
    ["unknown --command", { ...COMPLETE, command: "users nope" }, 'Unknown --command "users nope"'],
    ["malformed --error-code", { ...COMPLETE, errorCode: "Not-Linked" }, "Invalid --error-code"],
  ])("%s is a usage error even when telemetry is disabled", async (_label, options, message) => {
    process.env.CLERK_TELEMETRY_DISABLED = "1";
    const error = await usageErrorOf(options);
    expect(error.message).toContain(message);
    expect(posted).toHaveLength(0);
  });

  test.each([
    ["without --dry-run", {}],
    ["with --dry-run", { dryRun: true }],
  ])("a missing required field is a usage error %s", async (_label, extra) => {
    process.env.CLERK_TELEMETRY_DISABLED = "1";
    const error = await usageErrorOf({ goal: "x", outcome: "blocked", ...extra });
    expect(error.message).toBe("Missing required options: --attempted, --issue.");
    expect(captured.out).toBe("");
    expect(posted).toHaveLength(0);
  });

  test("a required field that is empty after trimming counts as missing", async () => {
    const error = await usageErrorOf({ ...COMPLETE, issue: "   " });
    expect(error.message).toBe("Missing required option: --issue.");
  });
});

// Scrubbing reads the whole field, so the field has a ceiling; past it the
// text is refused rather than cut, because a cut before scrubbing could split
// a secret. The ceiling is far above any cap, so it only ever meets a script
// that pasted a whole log into one field.
describe("a field over the input ceiling", () => {
  const CEILING = 1_000_000;

  test.each([["goal"], ["attempted"], ["issue"], ["errorText"], ["suggestion"]] as const)(
    "%s one character over is a usage error naming the field and the limit",
    async (field) => {
      process.env.CLERK_TELEMETRY_DISABLED = "1";
      const error = await usageErrorOf({ ...COMPLETE, [field]: "x".repeat(CEILING + 1) });
      expect(error.message).toContain(`--${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
      expect(error.message).toContain("1,000,000");
      expect(posted).toHaveLength(0);
    },
  );

  test("exactly at the ceiling is accepted, scrubbed and cut to the cap", async () => {
    await readyToSend();
    const result = await run({
      ...COMPLETE,
      issue: `${"x".repeat(CEILING - 20)} sk_test_abcdef1234`,
    });
    expect(result.sent).toBe(true);
    const issue = feedbackEvents()[0]!.payload.issue as string;
    expect(issue).toHaveLength(4000);
    expect(feedbackEvents()[0]!.payload.redactions).toBe(1);
  });
});

describe("gating", () => {
  test.each([
    ["CLERK_TELEMETRY_DISABLED", { CLERK_TELEMETRY_DISABLED: "1" }],
    ["DO_NOT_TRACK", { DO_NOT_TRACK: "1" }],
  ])("opt-out via %s yields telemetry_disabled and no request", async (_label, env) => {
    await readyToSend();
    Object.assign(process.env, env);
    expect(await run(COMPLETE)).toEqual({
      sent: false,
      reason: "telemetry_disabled",
      fallback: GITHUB_ISSUES_URL,
    });
    expect(posted).toHaveLength(0);
  });

  test("opt-out via `clerk telemetry disable` yields telemetry_disabled and no request", async () => {
    await readyToSend();
    await setTelemetryDisabled(true);
    expect(await run(COMPLETE)).toMatchObject({ sent: false, reason: "telemetry_disabled" });
    expect(posted).toHaveLength(0);
  });

  test("a dev build without CLERK_TELEMETRY_URL yields dev_build", async () => {
    await markTelemetryNoticeShown();
    expect(await run(COMPLETE)).toEqual({
      sent: false,
      reason: "dev_build",
      fallback: GITHUB_ISSUES_URL,
    });
    expect(posted).toHaveLength(0);
  });

  test("the daily cap refuses the eleventh report and allows the tenth", async () => {
    await readyToSend();
    await recordSends(FEEDBACK_DAILY_LIMIT - 1);
    expect((await run(COMPLETE)).sent).toBe(true);
    expect(await run(COMPLETE)).toMatchObject({ sent: false, reason: "rate_limited" });
    expect(feedbackEvents()).toHaveLength(1);
  });

  test("the repeat check refuses the same command and code, and allows a different code or an absent field", async () => {
    await readyToSend();
    const first = { ...COMPLETE, command: "users list", errorCode: "not_linked" };
    expect((await run(first)).sent).toBe(true);
    expect(await run(first)).toMatchObject({ sent: false, reason: "rate_limited" });
    expect((await run({ ...first, errorCode: "api_error" })).sent).toBe(true);
    expect((await run({ ...first, errorCode: undefined })).sent).toBe(true);
    expect((await run({ ...first, command: undefined })).sent).toBe(true);
  });

  // A send stopped before any POST (here by an opt-out) is not recorded; a
  // POST that was attempted is, whatever the endpoint answered (see "sending").
  test("a refused send is never recorded against the cap", async () => {
    await readyToSend();
    const first = { ...COMPLETE, command: "users list", errorCode: "not_linked" };
    process.env.CLERK_TELEMETRY_DISABLED = "1";
    expect(await run(first)).toMatchObject({ sent: false, reason: "telemetry_disabled" });
    delete process.env.CLERK_TELEMETRY_DISABLED;
    expect((await run(first)).sent).toBe(true);
    expect(posted).toHaveLength(1);
  });
});

describe("sending", () => {
  test("an accepted POST yields sent: true with the report id the event carries", async () => {
    await readyToSend();
    const result = await run(COMPLETE);
    expect(result.sent).toBe(true);
    expect(result.report_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(posted).toHaveLength(1);
    const [event] = posted[0]!.body.events;
    expect(event!.event).toBe(FEEDBACK_EVENT);
    expect((posted[0]!.body.events[0] as Record<string, unknown>).sdk).toBe("clerk-cli");
    expect(event!.payload.report_id).toBe(result.report_id);
    expect(event!.payload.source).toBe("cli");
  });

  test.each([[400], [500]])(
    "a %i from the endpoint yields send_failed with the report id",
    async (status) => {
      await readyToSend();
      respondWith = () => new Response("rejected", { status });
      const result = await run(COMPLETE);
      expect(result).toMatchObject({
        sent: false,
        reason: "send_failed",
        fallback: GITHUB_ISSUES_URL,
      });
      expect(result.report_id).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  test("a network failure yields send_failed with the report id and never throws", async () => {
    await readyToSend();
    respondWith = () => {
      throw new Error("network down");
    };
    const result = await run(COMPLETE);
    expect(result).toMatchObject({ sent: false, reason: "send_failed" });
    expect(result.report_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // The id is the handle for a later removal, so it is promised exactly when
  // a POST was attempted: a failure before the POST carries none.
  test("a failure before any POST yields send_failed with no report id", async () => {
    await readyToSend();
    const status = spyOn(telemetry, "getTelemetryStatus").mockImplementation(async () => {
      throw new Error("EACCES: config unreadable");
    });
    try {
      expect(await run(COMPLETE)).toEqual({
        sent: false,
        reason: "send_failed",
        fallback: GITHUB_ISSUES_URL,
      });
    } finally {
      status.mockRestore();
    }
    expect(posted).toHaveLength(0);
  });

  test("a sender failure before the POST yields send_failed with no report id", async () => {
    await readyToSend();
    const sender = spyOn(telemetry, "sendTelemetryEvent").mockImplementation(async () => {
      throw new Error("EACCES: config unreadable");
    });
    try {
      expect(await run(COMPLETE)).toEqual({
        sent: false,
        reason: "send_failed",
        fallback: GITHUB_ISSUES_URL,
      });
    } finally {
      sender.mockRestore();
    }
    expect(posted).toHaveLength(0);
  });

  // Ctrl-C is work interrupted, not a delivery outcome: the command follows
  // the CLI's interrupt path (exit 130 from the signal handler) and prints no
  // result of its own.
  test("an interrupt during the POST is rethrown, not reported as send_failed", async () => {
    await readyToSend();
    respondWith = () => {
      beginInterrupt();
      throw new DOMException("The operation was aborted.", "AbortError");
    };
    try {
      await expect(feedback(COMPLETE, program)).rejects.toThrow();
      expect(captured.out).toBe("");
    } finally {
      _resetInterruptState();
    }
  });

  // The cap counts a send whenever the request may have reached the server:
  // any response, a timeout, or a failure the CLI cannot place. A connection
  // that was never made (refused, unresolvable host, offline) sent nothing.
  const connectionError = (code: string) => () => {
    throw Object.assign(new Error("Unable to connect."), { code });
  };
  test.each([
    ["a rejected POST", () => new Response("rejected", { status: 500 })],
    [
      "a POST that throws an unknown error",
      () => {
        throw new Error("network down");
      },
    ],
    [
      "a POST that times out",
      () => {
        throw new DOMException("The operation timed out.", "AbortError");
      },
    ],
    ["a connection reset after the request", connectionError("ECONNRESET")],
  ])("%s is recorded against the cap", async (_label, respond) => {
    await readyToSend();
    const report = { ...COMPLETE, command: "users list", errorCode: "boom" };
    respondWith = respond;
    expect(await run(report)).toMatchObject({ sent: false, reason: "send_failed" });
    respondWith = () => new Response("{}");
    expect(await run(report)).toMatchObject({ sent: false, reason: "rate_limited" });
    expect(posted).toHaveLength(1);
  });

  test.each([
    ["refused or unresolvable (Bun reports both this way)", "ConnectionRefused"],
    ["a socket that could not open", "FailedToOpenSocket"],
    ["an unresolvable host", "ENOTFOUND"],
    ["a refused connection", "ECONNREFUSED"],
    ["no network", "ENETUNREACH"],
  ])("a connection never made (%s) is not recorded against the cap", async (_label, code) => {
    await readyToSend();
    const report = { ...COMPLETE, command: "users list", errorCode: "boom" };
    respondWith = connectionError(code);
    const failed = await run(report);
    expect(failed).toMatchObject({ sent: false, reason: "send_failed" });
    // A POST was attempted, so the id is still printed.
    expect(failed.report_id).toMatch(/^[0-9a-f-]{36}$/);
    respondWith = () => new Response("{}");
    expect((await run(report)).sent).toBe(true);
  });

  test("--command is normalised to the telemetry spelling", async () => {
    await readyToSend();
    await run({ ...COMPLETE, command: "clerk users list" });
    expect(feedbackEvents()[0]!.payload.command).toBe("users list");
  });

  test("--verbose prints the CLI_FEEDBACK event before the POST", async () => {
    await readyToSend();
    setLogLevel("debug");
    await run(COMPLETE);
    expect(captured.err).toContain('"event":"CLI_FEEDBACK"');
    expect(captured.err).toContain('"sdk":"clerk-cli"');
  });

  // The warehouse parses this payload by key; the key set is the contract.
  test("the payload carries exactly the agreed keys", async () => {
    await readyToSend();
    await run({
      ...COMPLETE,
      command: "users list",
      errorText: "boom",
      errorCode: "x",
      suggestion: "y",
    });
    const payload = feedbackEvents()[0]!.payload;
    expect(Object.keys(payload).sort()).toEqual(
      [
        "ai_agent",
        "app_id",
        "arch",
        "attempted",
        "ci",
        "command",
        "env",
        "error_code",
        "error_text",
        "goal",
        "in_screen",
        "in_tmux",
        "install_method",
        "issue",
        "machine_uuid",
        "mode",
        "os",
        "outcome",
        "redactions",
        "report_id",
        "source",
        "suggestion",
        "terminal_program",
        "workspace_id",
      ].sort(),
    );
  });

  test("optional fields are null, never absent, when not given", async () => {
    await readyToSend();
    await run(COMPLETE);
    const payload = feedbackEvents()[0]!.payload;
    expect(payload.command).toBeNull();
    expect(payload.error_text).toBeNull();
    expect(payload.error_code).toBeNull();
    expect(payload.suggestion).toBeNull();
    expect(payload.redactions).toBe(0);
  });
});

// The request-level proof that the scrubber is on every path: a secret of
// each CLI-specific shape, placed in each free-text field, never reaches the
// captured request. Fixtures are assembled at runtime where their shape would
// trip GitHub's push protection.
describe("every free-text field is scrubbed before the POST", () => {
  const SECRETS: Array<[string, string]> = [
    ["Platform API key", ["ak_", "1234567890abcdef"].join("")],
    ["named assignment", "CLERK_SECRET_KEY=notsk_value_123"],
    ["URL credentials", "postgres://alice:hunter2@db.example.com/app"],
    ["Authorization header", "Authorization: token abc123"],
    ["home directory", "/Users/alice/app/index.ts"],
    ["email", "alice@example.com"],
  ];
  const FIELDS = ["goal", "attempted", "issue", "errorText", "suggestion"] as const;
  const cases = FIELDS.flatMap((field) =>
    SECRETS.map(([label, secret]) => [field, label, secret] as const),
  );

  test.each(cases)("%s containing a %s", async (field, _label, secret) => {
    await readyToSend();
    await run({ ...COMPLETE, [field]: `context ${secret} more context` });
    const body = JSON.stringify(posted[0]!.body);
    const needle = secret.startsWith("CLERK_SECRET_KEY=")
      ? "notsk_value_123"
      : secret.replace(/^Authorization: /, "");
    expect(body).not.toContain(needle);
    expect(body).toMatch(
      new RegExp(
        `${REDACTED.replace(/[[\]]/g, "\\$&")}|${EMAIL_MARKER.replace(/[[\]]/g, "\\$&")}|~`,
      ),
    );
    expect(feedbackEvents()[0]!.payload.redactions).toBeGreaterThanOrEqual(1);
  });

  test("a field longer than its cap arrives at exactly the cap, scrubbed first", async () => {
    await readyToSend();
    await run({
      ...COMPLETE,
      issue: `${"x".repeat(3990)} sk_test_abcdef123456 ${"y".repeat(100)}`,
    });
    const issue = feedbackEvents()[0]!.payload.issue as string;
    expect(issue.length).toBeLessThanOrEqual(4000);
    expect(issue).not.toContain("abcdef");
  });
});

// Agent-mode dry-run output: the report a real run would send, plus whether a
// real run would send it now and, if not, the same reason a real run would
// print. Runs before the gates on purpose (it is how someone sees what would
// be sent), but never creates a machine id on an opted-out machine.
describe("--dry-run", () => {
  type DryRun = {
    dry_run: true;
    would_send: boolean;
    reason?: string;
    event: { sdk: string; sdkv: string; event: string; payload: Record<string, unknown> };
  };
  const dryRun = async (): Promise<DryRun> => {
    await feedback({ ...COMPLETE, dryRun: true }, program);
    return JSON.parse(captured.out) as DryRun;
  };

  test("when telemetry is on: would_send true, the report with its id, and nothing posted", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    const out = await dryRun();
    expect(out.dry_run).toBe(true);
    expect(out.would_send).toBe(true);
    expect(out.reason).toBeUndefined();
    expect(out.event.payload.report_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.event.payload.goal).toBe(COMPLETE.goal);
    expect(out.event.payload.machine_uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(posted).toHaveLength(0);
  });

  test("shows no first-run notice and touches no cap file, but may create the machine id", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    await dryRun();
    expect(captured.err).not.toContain("usage telemetry");
    expect(await Bun.file(join(configDir, "cache", "feedback-sends.json")).exists()).toBe(false);
    expect((await readConfig()).machineUuid).toMatch(/^[0-9a-f-]{36}$/);
    expect((await readConfig()).telemetryNoticeShown).toBeUndefined();
  });

  test("under an opt-out: would_send false with the reason, a null machine id, and no id created", async () => {
    process.env.CLERK_TELEMETRY_DISABLED = "1";
    const out = await dryRun();
    expect(out.would_send).toBe(false);
    expect(out.reason).toBe("telemetry_disabled");
    expect(out.event.payload.report_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.event.payload.machine_uuid).toBeNull();
    expect((await readConfig()).machineUuid).toBeUndefined();
    expect(posted).toHaveLength(0);
  });

  test("under an opt-out, an existing machine id is shown rather than null", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    await feedback(COMPLETE, program); // creates the id
    const existing = (await readConfig()).machineUuid;
    process.env.CLERK_TELEMETRY_DISABLED = "1";
    captured.clear();
    const out = await dryRun();
    expect(out.event.payload.machine_uuid).toBe(existing);
  });

  test("when capped: would_send false with rate_limited", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    await recordSends(FEEDBACK_DAILY_LIMIT);
    const out = await dryRun();
    expect(out.would_send).toBe(false);
    expect(out.reason).toBe("rate_limited");
  });

  // `would_send` must be false in exactly the states where a real run would
  // return `send_failed`: the machine id cannot be created, or the first-run
  // notice could not be recorded.
  test("reports send_failed when the machine id cannot be created (read-only config dir)", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    await chmod(configDir, 0o555);
    try {
      const out = await dryRun();
      expect(out.would_send).toBe(false);
      expect(out.reason).toBe("send_failed");
      expect(out.event.payload.machine_uuid).toBeNull();
    } finally {
      await chmod(configDir, 0o755);
    }
  });

  // The id exists, so building the envelope writes nothing; the config file
  // itself is read-only, so marking the notice would fail (a read-only
  // directory alone does not stop rewriting a file that already exists).
  test("reports send_failed when the notice is still owed and the config file cannot be written", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    await ensureMachineUuid();
    const configFile = join(configDir, "config.json");
    await chmod(configFile, 0o444);
    try {
      const out = await dryRun();
      expect(out.would_send).toBe(false);
      expect(out.reason).toBe("send_failed");
      expect(out.event.payload.machine_uuid).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await chmod(configFile, 0o644);
    }
  });

  // The writability probe must not write: a rewrite would race a concurrent
  // `clerk auth login` and would drop keys this version does not know.
  test("never rewrites the config file, keys it does not know included", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    await ensureMachineUuid();
    const configFile = join(configDir, "config.json");
    const withUnknownKey = (await Bun.file(configFile).text()).replace(
      /^\{/,
      '{"keyFromANewerVersion": {"x": 1},',
    );
    await Bun.write(configFile, withUnknownKey);
    const before = await stat(configFile);
    expect((await dryRun()).would_send).toBe(true);
    expect(await Bun.file(configFile).text()).toBe(withUnknownKey);
    expect((await stat(configFile)).mtimeMs).toBe(before.mtimeMs);
  });

  // A sandbox can deny writes while the permission bits allow them, so the
  // probe writes a temporary file next to the config file (never the config
  // file itself) and removes it.
  test("reports send_failed when a real write next to the config file is denied", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    await ensureMachineUuid();
    const probe = spyOn(hostExecution, "probeDirectoryWrite").mockImplementation(
      async (label, dir) => ({
        label,
        path: join(dir, ".clerk-write-probe"),
        error: "EPERM: operation not permitted",
      }),
    );
    try {
      const out = await dryRun();
      expect(out.would_send).toBe(false);
      expect(out.reason).toBe("send_failed");
      expect(probe).toHaveBeenCalledWith(expect.any(String), configDir);
    } finally {
      probe.mockRestore();
    }
  });

  test("the write probe leaves nothing behind in the config directory", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    await ensureMachineUuid();
    expect((await dryRun()).would_send).toBe(true);
    expect(
      (await readdir(configDir)).filter((name) => name.startsWith(".clerk-write-probe")),
    ).toEqual([]);
  });

  // The dry run asks the same question the first-run notice asks, so the two
  // cannot drift.
  test("decides whether the notice is owed with the telemetry module's own predicate", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    await ensureMachineUuid();
    const configFile = join(configDir, "config.json");
    await chmod(configFile, 0o444);
    const owed = spyOn(telemetry, "isTelemetryNoticeOwed").mockImplementation(async () => false);
    try {
      expect((await dryRun()).would_send).toBe(true);
      expect(owed).toHaveBeenCalled();
    } finally {
      owed.mockRestore();
      await chmod(configFile, 0o644);
    }
  });

  // Whatever fails inside a dry run, it still prints the dry-run shape.
  test("an error inside the dry run still prints the dry-run shape, with send_failed", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    const status = spyOn(telemetry, "getTelemetryStatus").mockImplementation(async () => {
      throw new Error("EACCES: config unreadable");
    });
    try {
      const out = await dryRun();
      expect(out.dry_run).toBe(true);
      expect(out.would_send).toBe(false);
      expect(out.reason).toBe("send_failed");
      expect(out.event.payload.goal).toBe(COMPLETE.goal);
    } finally {
      status.mockRestore();
    }
    expect(posted).toHaveLength(0);
  });

  // A failure past the gates (here, reading whether the notice is owed)
  // reaches the dry run's own catch rather than a gate's.
  test("an error past the gates still prints the dry-run shape, with send_failed", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    const owed = spyOn(telemetry, "isTelemetryNoticeOwed").mockImplementation(async () => {
      throw new Error("EACCES: config unreadable");
    });
    try {
      const out = await dryRun();
      expect(out.dry_run).toBe(true);
      expect(out.would_send).toBe(false);
      expect(out.reason).toBe("send_failed");
      expect(out.event.payload.goal).toBe(COMPLETE.goal);
    } finally {
      owed.mockRestore();
    }
  });

  // The preview is the event as posted, envelope wrapper included.
  test("shows the full event: sdk, CLI version, event name and payload", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    const out = await dryRun();
    expect(out.event.sdk).toBe("clerk-cli");
    expect(out.event.sdkv).toBe(CURRENT_VERSION);
    expect(out.event.event).toBe(FEEDBACK_EVENT);
    expect(Object.keys(out.event).sort()).toEqual(["event", "payload", "sdk", "sdkv"]);
  });

  test("would_send stays true in CI with an unwritable config file, where no notice is ever attempted", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    process.env.CI = "true";
    await ensureMachineUuid();
    const configFile = join(configDir, "config.json");
    await chmod(configFile, 0o444);
    try {
      expect((await dryRun()).would_send).toBe(true);
    } finally {
      await chmod(configFile, 0o644);
    }
  });
});

// Config failures must never escape as an exit-1 error: the per-run flush
// swallows them, and the feedback command reports `send_failed` instead.
describe("a config write failure", () => {
  test("creating the machine id in a read-only config dir yields send_failed, exit 0 semantics", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    process.env.CI = "true";
    await chmod(configDir, 0o555);
    try {
      expect(await run(COMPLETE)).toEqual({
        sent: false,
        reason: "send_failed",
        fallback: GITHUB_ISSUES_URL,
      });
    } finally {
      await chmod(configDir, 0o755);
    }
    expect(posted).toHaveLength(0);
  });

  test("marking the first-run notice shown throwing yields send_failed with the report id and no POST", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    const mark = spyOn(config, "markTelemetryNoticeShown").mockImplementation(async () => {
      throw new Error("EACCES: permission denied");
    });
    try {
      const result = await run(COMPLETE);
      // No POST was attempted, so no id: the README promises the id only when one was.
      expect(result).toEqual({ sent: false, reason: "send_failed", fallback: GITHUB_ISSUES_URL });
    } finally {
      mark.mockRestore();
    }
    expect(posted).toHaveLength(0);
  });
});

describe("the human-mode rate-limit message says which limit applied", () => {
  const originalMode = process.env.CLERK_MODE;
  beforeEach(() => {
    process.env.CLERK_MODE = "human";
  });
  afterEach(() => {
    if (originalMode === undefined) delete process.env.CLERK_MODE;
    else process.env.CLERK_MODE = originalMode;
  });

  test("the daily cap names the limit and the window", async () => {
    await readyToSend();
    await recordSends(FEEDBACK_DAILY_LIMIT);
    await feedback({ ...COMPLETE, yes: true }, program);
    expect(captured.err).toContain(`${FEEDBACK_DAILY_LIMIT} reports in 24 hours`);
    expect(captured.err).not.toContain("same command and error code");
  });

  test("the repeat check names the command and code", async () => {
    await readyToSend();
    await recordFeedbackSend({ sentAt: Date.now() - 1000, command: "users list", errorCode: "x" });
    await feedback({ ...COMPLETE, command: "users list", errorCode: "x", yes: true }, program);
    expect(captured.err).toContain("same command and error code");
    expect(captured.err).toContain("24 hours");
  });
});

describe("first-run notice", () => {
  test("a first run shows the feedback variant immediately before the POST and still sends", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    const result = await run(COMPLETE);
    expect(result.sent).toBe(true);
    expect(captured.err).toContain("This run sends the feedback report you asked for");
    expect(captured.err).not.toContain("Nothing has been sent during this run");
    expect(posted).toHaveLength(1);
    // Marked shown: the next run is silent.
    captured.clear();
    await run(COMPLETE);
    expect(captured.err).not.toContain("usage telemetry");
  });

  test("an opted-out first run shows no notice", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    process.env.DO_NOT_TRACK = "1";
    await run(COMPLETE);
    expect(captured.err).not.toContain("usage telemetry");
  });

  test("a capped first run shows no notice", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    await recordSends(FEEDBACK_DAILY_LIMIT);
    expect(await run(COMPLETE)).toMatchObject({ reason: "rate_limited" });
    expect(captured.err).not.toContain("usage telemetry");
  });

  test("CI sends on the first run with no notice", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    process.env.CI = "true";
    expect((await run(COMPLETE)).sent).toBe(true);
    expect(captured.err).not.toContain("usage telemetry");
  });
});

// Human mode, driven with the editor prompt stubbed: the opt-out is checked
// again after the prompts close, and once more at the moment of sending, so an
// opt-out that lands while the editor is open never results in a POST.
describe("an opt-out that lands during a human-mode prompt", () => {
  const originalMode = process.env.CLERK_MODE;
  beforeEach(() => {
    process.env.CLERK_MODE = "human";
  });
  afterEach(() => {
    if (originalMode === undefined) delete process.env.CLERK_MODE;
    else process.env.CLERK_MODE = originalMode;
  });

  test("during the editor: told before any preview, no POST, no machine id created", async () => {
    await readyToSend();
    const editor = spyOn(prompts, "editor").mockImplementation(async () => {
      await setTelemetryDisabled(true);
      return "typed in the editor";
    });
    try {
      await feedback({ ...COMPLETE, attempted: undefined, yes: true }, program);
    } finally {
      editor.mockRestore();
    }
    expect(captured.out).toBe("");
    expect(captured.err).toContain("Telemetry is disabled on this machine");
    expect(posted).toHaveLength(0);
    expect((await readConfig()).machineUuid).toBeUndefined();
  });

  // Only the send path turns a failure into send_failed. A prompt or editor
  // that fails is the person's problem to see, with its own message.
  test.each([
    ["the editor", "editor", { attempted: undefined }],
    ["a text prompt", "text", { goal: undefined }],
    ["the confirmation", "confirm", {}],
  ] as const)(
    "a failure in %s surfaces as its own error, not send_failed",
    async (_label, prompt, missing) => {
      await readyToSend();
      const failing = spyOn(prompts, prompt).mockImplementation(async () => {
        throw new Error("Editor exited with code 1");
      });
      try {
        await expect(feedback({ ...COMPLETE, ...missing }, program)).rejects.toThrow(
          "Editor exited with code 1",
        );
      } finally {
        failing.mockRestore();
      }
      expect(captured.err).not.toContain("could not be sent");
      expect(posted).toHaveLength(0);
    },
  );

  test("the preview prints the full event as posted", async () => {
    await readyToSend();
    await feedback({ ...COMPLETE, yes: true }, program);
    const preview = JSON.parse(captured.out) as Posted["body"]["events"][number] & {
      sdk: string;
      sdkv: string;
    };
    expect(preview.sdk).toBe("clerk-cli");
    expect(preview.sdkv).toBe(CURRENT_VERSION);
    expect(posted[0]!.body.events[0]).toEqual(preview);
  });

  // On a fresh machine, so the first-run notice is still owed: it must not be
  // shown or marked for a report that the late opt-out stops.
  test("during the confirmation: the previewed report is not posted and the first-run notice stays owed", async () => {
    process.env.CLERK_TELEMETRY_URL = CAPTURE_URL;
    const confirm = spyOn(prompts, "confirm").mockImplementation(async () => {
      await setTelemetryDisabled(true);
      return true;
    });
    try {
      await feedback(COMPLETE, program);
    } finally {
      confirm.mockRestore();
    }
    expect(captured.out).toContain('"goal": "pull the dev keys"');
    expect(captured.err).toContain("Telemetry is disabled on this machine");
    expect(captured.err).not.toContain("usage telemetry");
    expect(posted).toHaveLength(0);
    expect((await readConfig()).telemetryNoticeShown).toBeUndefined();
  });
});
