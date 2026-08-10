import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createProgram, formatApiBody, outputJsonError, reportError } from "./cli-program.ts";
import {
  ApiError,
  CliError,
  ERROR_CODE,
  EXIT_CODE,
  PlapiError,
  UserAbortError,
} from "./lib/errors.ts";
import { telemetryResultForError } from "./lib/telemetry.ts";
import { useCaptureLog } from "./test/lib/stubs.ts";

test("registers users as a top-level command", () => {
  const program = createProgram();
  const users = program.commands.find((command) => command.name() === "users");
  expect(users).toBeDefined();
});

test("does not register the removed clerk skill command", () => {
  const program = createProgram();
  const skill = program.commands.find((command) => command.name() === "skill");
  expect(skill).toBeUndefined();
});

test("registers users create and list as subcommands", () => {
  const program = createProgram();
  const users = program.commands.find((command) => command.name() === "users")!;
  const names = users.commands.map((command) => command.name());

  expect(names).toEqual(expect.arrayContaining(["create", "list"]));
});

test("users list exposes common filters and pagination options", () => {
  const program = createProgram();
  const users = program.commands.find((command) => command.name() === "users")!;
  const list = users.commands.find((command) => command.name() === "list")!;
  const optionNames = list.options.map((option) => option.long);

  expect(optionNames).toEqual(
    expect.arrayContaining([
      "--json",
      "--limit",
      "--offset",
      "--query",
      "--email-address",
      "--phone-number",
      "--username",
      "--user-id",
      "--external-id",
      "--order-by",
      "--secret-key",
      "--app",
      "--instance",
    ]),
  );
});

test("deploy relies on global options", () => {
  const program = createProgram();
  const deploy = program.commands.find((command) => command.name() === "deploy")!;
  const optionNames = deploy.options.map((option) => option.long);

  expect(optionNames).toEqual([]);
});

test("deploy status exposes wait option", () => {
  const program = createProgram();
  const deploy = program.commands.find((command) => command.name() === "deploy")!;
  const status = deploy.commands.find((command) => command.name() === "status")!;
  const optionNames = status.options.map((option) => option.long);

  expect(optionNames).toContain("--wait");
});

describe("parseIntegerOption (via users list --limit / --offset)", () => {
  function parseUsersList(args: readonly string[]) {
    return createProgram().parseAsync(["users", "list", ...args], { from: "user" });
  }

  test.each([
    {
      label: "--limit 0",
      args: ["--limit", "0"],
      expected: /Must be 1-250/,
    },
    {
      label: "--limit 251",
      args: ["--limit", "251"],
      expected: /Must be 1-250/,
    },
    {
      label: "--limit -5 (post-fix surfaces range message)",
      args: ["--limit", "-5"],
      expected: /Must be 1-250/,
    },
    {
      label: "--limit abc",
      args: ["--limit", "abc"],
      expected: /Must be an integer/,
    },
    {
      label: "--limit 1.5",
      args: ["--limit", "1.5"],
      expected: /Must be an integer/,
    },
    {
      label: "--offset -1",
      args: ["--offset", "-1"],
      expected: /Must be >= 0/,
    },
  ])("rejects $label", async ({ args, expected }) => {
    await expect(parseUsersList(args)).rejects.toThrow(expected);
  });
});

test("users create exposes --json output, curated flags, and -d/--data for inline request bodies", () => {
  const program = createProgram();
  const users = program.commands.find((command) => command.name() === "users")!;
  const create = users.commands.find((command) => command.name() === "create")!;
  const optionNames = create.options.map((option) => option.long);

  expect(optionNames).toEqual(
    expect.arrayContaining([
      "--json",
      "--email",
      "--phone",
      "--username",
      "--password",
      "--first-name",
      "--last-name",
      "--external-id",
      "--data",
      "--file",
      "--dry-run",
      "--yes",
    ]),
  );
});

test("users parent command exposes targeting flags inherited by subcommands", () => {
  const program = createProgram();
  const users = program.commands.find((command) => command.name() === "users")!;
  const optionNames = users.options.map((option) => option.long);

  expect(optionNames).toEqual(expect.arrayContaining(["--secret-key", "--app", "--instance"]));
});

test("users create documents -d and --file for raw BAPI request bodies", () => {
  const program = createProgram();
  const users = program.commands.find((command) => command.name() === "users")!;
  const create = users.commands.find((command) => command.name() === "create")!;
  const help = create.helpInformation();

  expect(help).toContain("-d, --data");
  expect(help).toContain("--file");
});

describe("formatApiBody", () => {
  // --- Single error with meta ---

  test("surfaces unsupported_features from meta", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "unsupported_subscription_plan_features",
          message: "Your plan does not support these features",
          meta: { unsupported_features: ["saml", "custom_roles"] },
        },
      ],
    });
    const result = formatApiBody(new ApiError(400, body), false);
    expect(result).toContain("Your plan does not support these features");
    expect(result).toContain("Unsupported features: saml, custom_roles");
  });

  test("surfaces suggestions from unknown_config_key meta", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "unknown_config_key",
          message: "Unknown config key: sesion",
          meta: { param_name: "sesion", suggestions: ["session"] },
        },
      ],
    });
    const result = formatApiBody(new ApiError(400, body), false);
    expect(result).toContain("Unknown config key: sesion");
    expect(result).toContain("Did you mean: session");
    expect(result).toContain("Parameter: sesion");
  });

  test("surfaces feature name from feature_not_enabled meta", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "feature_not_enabled",
          message: "This feature is not enabled on this instance",
          meta: { param_name: "organizations" },
        },
      ],
    });
    const result = formatApiBody(new ApiError(400, body), false);
    expect(result).toContain("This feature is not enabled on this instance");
    expect(result).toContain("Feature: organizations");
  });

  test("surfaces param_name for config_validation_error", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "config_validation_error",
          message: "Invalid value for session.lifetime",
          meta: { param_name: "session.lifetime", config_key: "session" },
        },
      ],
    });
    const result = formatApiBody(new ApiError(400, body), false);
    expect(result).toContain("Invalid value for session.lifetime");
    expect(result).toContain("Parameter: session.lifetime");
  });

  test("surfaces param_name for destructive_operation_not_allowed", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "destructive_operation_not_allowed",
          message: "Cannot clear this key without destructive=true",
          meta: { param_name: "sign_up.mode" },
        },
      ],
    });
    const result = formatApiBody(new ApiError(400, body), false);
    expect(result).toContain("Cannot clear this key");
    expect(result).toContain("Parameter: sign_up.mode");
  });

  test("surfaces param_name for form_param_value_invalid", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "form_param_value_invalid",
          message: "Value is not in the allowed set",
          meta: { param_name: "branding.logo_url" },
        },
      ],
    });
    const result = formatApiBody(new ApiError(400, body), false);
    expect(result).toContain("Value is not in the allowed set");
    expect(result).toContain("Parameter: branding.logo_url");
  });

  // --- Multiple errors ---
  // The structured path reads from the first parsed error only.

  test("formats multiple errors: surfaces first error with its meta", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "config_validation_error",
          message: "Invalid session lifetime",
          meta: { param_name: "session.lifetime" },
        },
        {
          code: "unknown_config_key",
          message: "Unknown key: bogus",
          meta: { param_name: "bogus", suggestions: ["session"] },
        },
      ],
    });
    const result = formatApiBody(new ApiError(400, body), false);
    expect(result).toContain("Invalid session lifetime");
    expect(result).toContain("Parameter: session.lifetime");
  });

  // --- Error without meta ---

  test("handles error without meta gracefully", () => {
    const body = JSON.stringify({
      errors: [{ code: "resource_not_found", message: "Instance not found" }],
    });
    const result = formatApiBody(new ApiError(400, body), false);
    expect(result).toBe("Instance not found");
  });

  // --- Bodies without a Clerk errors array ---
  // parseApiBody falls back to truncateBody(body) as the message when there
  // is no errors[0], so formatStructuredError returns the truncated body string.

  test("returns truncated body when no errors array (error field only)", () => {
    const body = JSON.stringify({ error: "Something went wrong" });
    const result = formatApiBody(new ApiError(400, body), false);
    expect(result).toBe(body);
  });

  test("returns truncated body when no errors array (message field only)", () => {
    const body = JSON.stringify({ message: "Bad request" });
    const result = formatApiBody(new ApiError(400, body), false);
    expect(result).toBe(body);
  });

  test("truncates non-JSON body over 200 chars", () => {
    const body = "x".repeat(300);
    const result = formatApiBody(new ApiError(400, body), false);
    expect(result).toBe("x".repeat(200) + "...");
  });

  test("returns short non-JSON body as-is", () => {
    const result = formatApiBody(new ApiError(400, "Bad Request"), false);
    expect(result).toBe("Bad Request");
  });

  // --- Verbose mode ---

  test("verbose mode returns full pretty-printed JSON", () => {
    const obj = { errors: [{ code: "test", message: "test msg" }] };
    const body = JSON.stringify(obj);
    const result = formatApiBody(new ApiError(400, body), true);
    expect(result).toBe("\n" + JSON.stringify(obj, null, 2));
  });

  test("verbose mode returns raw body for non-JSON", () => {
    const result = formatApiBody(new ApiError(400, "not json"), true);
    expect(result).toBe("\nnot json");
  });

  // --- Edge cases ---

  test("handles empty errors array by returning truncated body", () => {
    const body = JSON.stringify({ errors: [], message: "fallback" });
    const result = formatApiBody(new ApiError(400, body), false);
    // No errors[0] so parseApiBody falls back to truncateBody(body)
    expect(result).toBe(body);
  });

  test("handles error with empty meta", () => {
    const body = JSON.stringify({
      errors: [{ code: "config_validation_error", message: "Bad value", meta: {} }],
    });
    const result = formatApiBody(new ApiError(400, body), false);
    expect(result).toBe("Bad value");
  });

  test("handles unsupported_subscription_plan_features with empty unsupported_features", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "unsupported_subscription_plan_features",
          message: "Plan limitation",
          meta: { unsupported_features: [] },
        },
      ],
    });
    const result = formatApiBody(new ApiError(400, body), false);
    expect(result).toBe("Plan limitation");
  });
});

describe("outputJsonError", () => {
  const captured = useCaptureLog();

  const parse = () => JSON.parse(captured.err.trim()) as { error: Record<string, unknown> };

  test("includes raw {command, description} examples in the payload", () => {
    outputJsonError("usage_error", "--forward-to <url> is required.", undefined, undefined, [
      { command: "clerk webhooks listen --forward-to <url>", description: "Forward events" },
    ]);
    expect(parse().error.examples).toEqual([
      { command: "clerk webhooks listen --forward-to <url>", description: "Forward events" },
    ]);
  });

  test("omits the examples key when there are none", () => {
    outputJsonError("usage_error", "boom");
    expect(parse().error).not.toHaveProperty("examples");
  });
});

// `reportError` is the whole error-dispatch cascade of `runProgram`'s catch,
// minus the `process.exit` call. Exercising it directly is the only way to
// cover every branch — going through `runProgram` needs a `process.exit` spy
// and can only reach one branch per invocation.
describe("reportError", () => {
  const captured = useCaptureLog();

  // `getMode()` falls back to TTY detection, which reports agent mode under the
  // test runner. Drive the env var rather than `setMode()` so the override is
  // restorable — `mode.ts` exposes no way to clear a forced mode.
  const originalMode = process.env.CLERK_MODE;
  const asHuman = () => {
    process.env.CLERK_MODE = "human";
  };
  const asAgent = () => {
    process.env.CLERK_MODE = "agent";
  };

  beforeEach(asHuman);
  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.CLERK_MODE;
    } else {
      process.env.CLERK_MODE = originalMode;
    }
  });

  const json = () => JSON.parse(captured.err.trim()) as { error: Record<string, any> };

  /** Matches what `@inquirer/prompts` throws on Ctrl+C. */
  const promptExitError = () => {
    const error = new Error("User force closed the prompt with SIGINT");
    error.name = "ExitPromptError";
    return error;
  };

  describe("aborts", () => {
    test("UserAbortError exits clean and prints nothing", () => {
      expect(reportError(new UserAbortError(), false)).toBe(EXIT_CODE.SUCCESS);
      expect(captured.err).toBe("");
      expect(captured.out).toBe("");
    });

    test("a force-closed prompt exits clean and prints nothing", () => {
      expect(reportError(promptExitError(), false)).toBe(EXIT_CODE.SUCCESS);
      expect(captured.err).toBe("");
      expect(captured.out).toBe("");
    });

    test("an ExitPromptError with a different message is not treated as an abort", () => {
      const error = new Error("something else");
      error.name = "ExitPromptError";
      expect(reportError(error, false)).toBe(EXIT_CODE.GENERAL);
      expect(captured.err).toContain("something else");
    });
  });

  describe("CliError", () => {
    test("returns the error's own exit code", () => {
      const error = new CliError("bad flag", {
        code: ERROR_CODE.USAGE_ERROR,
        exitCode: EXIT_CODE.USAGE,
      });
      expect(reportError(error, false)).toBe(EXIT_CODE.USAGE);
    });

    test("human mode prints message, examples, and docs link", () => {
      const error = new CliError("Not linked", {
        code: ERROR_CODE.NOT_LINKED,
        docsUrl: "https://example.com/docs/link",
        examples: [{ command: "clerk link", description: "Link this directory" }],
      });
      reportError(error, false);
      expect(captured.err).toContain("Not linked");
      expect(captured.err).toContain("clerk link");
      expect(captured.err).toContain("For more information, see: https://example.com/docs/link");
    });

    test("agent mode emits a JSON payload carrying code, docs URL, and examples", () => {
      asAgent();
      const error = new CliError("Not linked", {
        code: ERROR_CODE.NOT_LINKED,
        docsUrl: "https://example.com/docs/link",
        examples: [{ command: "clerk link", description: "Link this directory" }],
      });
      expect(reportError(error, false)).toBe(EXIT_CODE.GENERAL);
      expect(json().error).toMatchObject({
        code: ERROR_CODE.NOT_LINKED,
        message: "Not linked",
        docsUrl: "https://example.com/docs/link",
        examples: [{ command: "clerk link", description: "Link this directory" }],
      });
    });

    test("agent mode falls back to human rendering when the error has no code", () => {
      asAgent();
      reportError(new CliError("uncoded failure"), false);
      expect(captured.err).toContain("uncoded failure");
      expect(() => json()).toThrow();
    });
  });

  describe("ApiError", () => {
    const body = JSON.stringify({
      errors: [
        { code: "form_param_missing", message: "Missing param", meta: { param_name: "email" } },
      ],
      clerk_trace_id: "trace_123",
    });

    // Only the prefix + status wiring is asserted here; the detail string is
    // `formatStructuredError`'s job and is covered by the `formatApiBody` block.
    test("human mode prefixes with the status", () => {
      reportError(new ApiError(400, body), false);
      expect(captured.err).toContain("Request failed (400): Missing param");
    });

    test("human mode prefers the error's context over the default prefix", () => {
      const error = new ApiError(400, body);
      error.context = "Platform API request failed";
      reportError(error, false);
      expect(captured.err).toContain("Platform API request failed (400):");
      expect(captured.err).not.toContain("Request failed (400):");
    });

    test("verbose adds the request URL and trace id", () => {
      reportError(new PlapiError(400, body, "https://api.clerk.com/v1/apps"), true);
      expect(captured.err).toContain("URL: https://api.clerk.com/v1/apps");
      expect(captured.err).toContain("Trace: trace_123");
    });

    test("agent mode emits the code and a structured errors array", () => {
      asAgent();
      reportError(new ApiError(400, body), false);
      expect(json().error).toMatchObject({
        code: "form_param_missing",
        message: "Request failed (400): Missing param\n  Parameter: email",
        errors: [
          { code: "form_param_missing", message: "Missing param", meta: { param_name: "email" } },
        ],
      });
    });

    test("agent mode falls back to api_error and omits errors when there is no code or meta", () => {
      asAgent();
      reportError(new ApiError(502, "upstream exploded"), false);
      expect(json().error.code).toBe("api_error");
      expect(json().error).not.toHaveProperty("errors");
    });
  });

  describe("unexpected failures", () => {
    test("a plain Error prints its message in human mode", () => {
      expect(reportError(new Error("socket hang up"), false)).toBe(EXIT_CODE.GENERAL);
      expect(captured.err).toContain("socket hang up");
    });

    test("a plain Error becomes unexpected_error in agent mode", () => {
      asAgent();
      reportError(new Error("socket hang up"), false);
      expect(json().error).toMatchObject({
        code: "unexpected_error",
        message: "socket hang up",
      });
    });

    test("a non-Error throw gets a generic message in human mode", () => {
      expect(reportError("just a string", false)).toBe(EXIT_CODE.GENERAL);
      expect(captured.err).toContain("An unexpected error occurred");
    });

    test("a non-Error throw gets a generic message in agent mode", () => {
      asAgent();
      expect(reportError({ nope: true }, false)).toBe(EXIT_CODE.GENERAL);
      expect(json().error).toMatchObject({
        code: "unexpected_error",
        message: "An unexpected error occurred",
      });
    });
  });

  // `telemetryResultForError` runs the same instanceof cascade to decide what
  // exit code the event reports. If the two drift, telemetry records a code the
  // user never saw, and nothing else in the suite would notice.
  describe("agrees with telemetryResultForError on the exit code", () => {
    const fixtures: [string, unknown][] = [
      ["UserAbortError", new UserAbortError()],
      ["prompt exit", promptExitError()],
      ["CliError (default code)", new CliError("boom")],
      [
        "CliError (usage code)",
        new CliError("bad flag", { code: ERROR_CODE.USAGE_ERROR, exitCode: EXIT_CODE.USAGE }),
      ],
      ["ApiError", new ApiError(404, "{}")],
      ["PlapiError", new PlapiError(500, "{}", "https://api.clerk.com/v1/apps")],
      ["plain Error", new Error("socket hang up")],
      ["non-Error throw", "just a string"],
    ];

    for (const [name, error] of fixtures) {
      test(name, () => {
        expect(reportError(error, false)).toBe(telemetryResultForError(error).exitCode);
      });
    }
  });
});
