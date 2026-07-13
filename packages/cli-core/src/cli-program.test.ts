import { test, expect, describe } from "bun:test";
import { createProgram, formatApiBody, outputJsonError } from "./cli-program.ts";
import { ApiError } from "./lib/errors.ts";
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

test("branch command exposes create, list, delete, and switch", () => {
  const program = createProgram();
  const branch = program.commands.find((command) => command.name() === "branch")!;
  const names = branch.commands.map((command) => command.name());

  expect(names).toEqual(["create", "list", "delete", "switch"]);
});

test("registers switch as a top-level command aliasing branch switch", () => {
  const program = createProgram();
  const switchCommand = program.commands.find((command) => command.name() === "switch")!;
  expect(switchCommand).toBeDefined();

  const optionNames = switchCommand.options.map((option) => option.long);
  // Pinned exactly: branches always fork the development root, so the surface
  // carries no parent-selection flag.
  expect(optionNames).toEqual(["--create", "--app", "--no-pull", "--detach", "--yes", "--json"]);
});

test("branch create forks the development root with no parent-selection flag", () => {
  const program = createProgram();
  const branch = program.commands.find((command) => command.name() === "branch")!;
  const create = branch.commands.find((command) => command.name() === "create")!;
  const optionNames = create.options.map((option) => option.long);

  // Pinned exactly: only --name/--app/--json, no parent-selection flag.
  expect(optionNames).toEqual(["--name", "--app", "--json"]);
});

test("env pull exposes branch targeting", () => {
  const program = createProgram();
  const env = program.commands.find((command) => command.name() === "env")!;
  const pull = env.commands.find((command) => command.name() === "pull")!;
  const optionNames = pull.options.map((option) => option.long);

  expect(optionNames).toContain("--branch");
});

test.each([
  { label: "config pull", path: ["config", "pull"] },
  { label: "enable orgs", path: ["enable", "orgs"] },
  { label: "users", path: ["users"] },
  { label: "api", path: ["api"] },
  { label: "impersonate", path: ["impersonate"] },
])("$label accepts both --instance and --branch", ({ path }) => {
  const program = createProgram();
  const parent = program.commands.find((candidate) => candidate.name() === path[0])!;
  const command = path[1]
    ? parent.commands.find((candidate) => candidate.name() === path[1])!
    : parent;

  const optionNames = command.options.map((option) => option.long);
  expect(optionNames).toContain("--instance");
  expect(optionNames).toContain("--branch");
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

  test("names the live-fork count from cannot_disable_branches_with_live_forks long_message", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "cannot_disable_branches_with_live_forks",
          message: "Delete your branches before disabling.",
          long_message:
            "Development branching can't be disabled while 3 branch(es) exist. Delete your branches first.",
        },
      ],
    });
    const result = formatApiBody(new ApiError(400, body), false);
    expect(result).toContain("Delete your branches before disabling.");
    expect(result).toContain("3 branch(es) exist");
  });

  test("surfaces the enable hint from development_branches_not_enabled long_message", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "development_branches_not_enabled",
          message: "Development branches aren't enabled.",
          long_message:
            "Run `clerk enable branches` or enable development branches in the dashboard.",
        },
      ],
    });
    const result = formatApiBody(new ApiError(403, body), false);
    expect(result).toContain("Development branches aren't enabled.");
    expect(result).toContain("clerk enable branches");
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
