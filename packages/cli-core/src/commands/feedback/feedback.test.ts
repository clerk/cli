/**
 * Agent-mode behaviour of the handler, with the POST captured through
 * CLERK_TELEMETRY_URL. Tests have no TTY, so the mode resolves to agent.
 * Human-mode prompts and the exit codes of a real invocation are covered by
 * the integration test (`src/test/integration/feedback.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgram } from "../../cli-program.ts";
import * as config from "../../lib/config.ts";
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

  test("a refused send is never recorded against the cap", async () => {
    await readyToSend();
    respondWith = () => new Response("nope", { status: 500 });
    const first = { ...COMPLETE, command: "users list", errorCode: "not_linked" };
    expect(await run(first)).toMatchObject({ sent: false, reason: "send_failed" });
    respondWith = () => new Response("{}");
    expect((await run(first)).sent).toBe(true);
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

  test("a network failure yields send_failed and never throws", async () => {
    await readyToSend();
    respondWith = () => {
      throw new Error("network down");
    };
    expect(await run(COMPLETE)).toMatchObject({ sent: false, reason: "send_failed" });
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
    report: Record<string, unknown>;
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
    expect(out.report.report_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.report.goal).toBe(COMPLETE.goal);
    expect(out.report.machine_uuid).toMatch(/^[0-9a-f-]{36}$/);
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
    expect(out.report.report_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.report.machine_uuid).toBeNull();
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
    expect(out.report.machine_uuid).toBe(existing);
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
      expect(out.report.machine_uuid).toBeNull();
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
      expect(out.report.machine_uuid).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await chmod(configFile, 0o644);
    }
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
