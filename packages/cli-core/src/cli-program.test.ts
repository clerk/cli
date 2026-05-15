import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProgram, formatApiBody } from "./cli-program.ts";
import { STANDARD_AGENT_DIRS, EXTRA_REL_PATHS } from "./lib/skill-detection.ts";

test("registers users as a top-level command", () => {
  const program = createProgram();
  const users = program.commands.find((command) => command.name() === "users");
  expect(users).toBeDefined();
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

describe("agent-CLI discoverability surface", () => {
  test("top-level --help renders Examples: with at least one agent-pipeable command", () => {
    const help = createProgram().helpInformation();
    expect(help).toContain("Examples:");
    expect(help).toMatch(/clerk apps list --json/);
  });

  test("top-level --help renders Environment: with CLERK_* env vars actually read in cli-core", () => {
    const help = createProgram().helpInformation();
    expect(help).toContain("Environment:");
    expect(help).toContain("CLERK_SECRET_KEY");
    expect(help).toContain("CLERK_MODE");
  });

  test("data-returning subcommands document --json field shape", () => {
    const program = createProgram();
    const usersList = program.commands
      .find((c) => c.name() === "users")!
      .commands.find((c) => c.name() === "list")!;
    const appsList = program.commands
      .find((c) => c.name() === "apps")!
      .commands.find((c) => c.name() === "list")!;

    expect(usersList.helpInformation()).toMatch(/--json[^\n]*\bdata\b[^\n]*\bhasMore\b/);
    expect(appsList.helpInformation()).toMatch(/--json[^\n]*\bapplication_id\b/);
  });

  test("auth login --help documents the headless path via --token and CLERK_SECRET_KEY", () => {
    const program = createProgram();
    const auth = program.commands.find((c) => c.name() === "auth")!;
    const login = auth.commands.find((c) => c.name() === "login")!;
    const help = login.helpInformation();

    const optionNames = login.options.map((o) => o.long);
    expect(optionNames).toContain("--token");
    expect(help).toContain("CLERK_SECRET_KEY");
    expect(help).toMatch(/headless/i);
  });

  test("setEnvVars only documents CLERK_* names the binary actually reads", () => {
    // Names listed in `Environment:` must match what the CLI reads via
    // process.env.CLERK_* — otherwise the help text drifts and lies.
    const documentedEnvVars = [
      ...createProgram()
        .helpInformation()
        .matchAll(/\bCLERK_[A-Z0-9_]+\b/g),
    ].map((m) => m[0]);
    const knownReadByCli = new Set([
      "CLERK_SECRET_KEY",
      "CLERK_MODE",
      "CLERK_CONFIG_DIR",
      "CLERK_UPDATE_CHANNEL",
      "CLERK_NO_UPDATE_CHECK",
    ]);
    for (const name of new Set(documentedEnvVars)) {
      expect(knownReadByCli).toContain(name);
    }
    expect(documentedEnvVars.length).toBeGreaterThan(0);
  });
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
    const result = formatApiBody(body, false);
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
    const result = formatApiBody(body, false);
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
    const result = formatApiBody(body, false);
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
    const result = formatApiBody(body, false);
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
    const result = formatApiBody(body, false);
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
    const result = formatApiBody(body, false);
    expect(result).toContain("Value is not in the allowed set");
    expect(result).toContain("Parameter: branding.logo_url");
  });

  // --- Multiple errors ---

  test("formats multiple errors joined by newlines", () => {
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
    const result = formatApiBody(body, false);
    expect(result).toContain("Invalid session lifetime");
    expect(result).toContain("Unknown key: bogus");
    expect(result).toContain("Did you mean: session");
    // Two errors separated by newline
    const lines = result.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  // --- Error without meta ---

  test("handles error without meta gracefully", () => {
    const body = JSON.stringify({
      errors: [{ code: "resource_not_found", message: "Instance not found" }],
    });
    const result = formatApiBody(body, false);
    expect(result).toBe("Instance not found");
  });

  // --- Fallback paths ---

  test("falls back to parsed.error when no errors array", () => {
    const body = JSON.stringify({ error: "Something went wrong" });
    const result = formatApiBody(body, false);
    expect(result).toBe("Something went wrong");
  });

  test("falls back to parsed.message when no errors array or error field", () => {
    const body = JSON.stringify({ message: "Bad request" });
    const result = formatApiBody(body, false);
    expect(result).toBe("Bad request");
  });

  test("truncates non-JSON body over 200 chars", () => {
    const body = "x".repeat(300);
    const result = formatApiBody(body, false);
    expect(result).toBe("x".repeat(200) + "...");
  });

  test("returns short non-JSON body as-is", () => {
    const result = formatApiBody("Bad Request", false);
    expect(result).toBe("Bad Request");
  });

  // --- Verbose mode ---

  test("verbose mode returns full pretty-printed JSON", () => {
    const obj = { errors: [{ code: "test", message: "test msg" }] };
    const body = JSON.stringify(obj);
    const result = formatApiBody(body, true);
    expect(result).toBe("\n" + JSON.stringify(obj, null, 2));
  });

  test("verbose mode returns raw body for non-JSON", () => {
    const result = formatApiBody("not json", true);
    expect(result).toBe("\nnot json");
  });

  // --- Edge cases ---

  test("handles empty errors array by falling through", () => {
    const body = JSON.stringify({ errors: [], message: "fallback" });
    const result = formatApiBody(body, false);
    expect(result).toBe("fallback");
  });

  test("handles error with empty meta", () => {
    const body = JSON.stringify({
      errors: [{ code: "config_validation_error", message: "Bad value", meta: {} }],
    });
    const result = formatApiBody(body, false);
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
    const result = formatApiBody(body, false);
    expect(result).toBe("Plan limitation");
  });
});

describe("help: clerk skill install tip", () => {
  const TIP_SUBSTR = "Give AI agents better Clerk context";

  // Capture help output including `addHelpText("after", ...)`. The custom
  // formatter in lib/help.ts rebuilds help from scratch, so the "after"
  // listener only fires during outputHelp (which writes via stdout).
  function renderHelp(): string {
    const program = createProgram();
    let captured = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as unknown as { write: (chunk: any) => boolean }).write = (chunk) => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
    try {
      program.outputHelp();
    } finally {
      (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
    }
    return captured;
  }

  let tmpHome: string;
  let tmpCwd: string;
  let originalHome: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    tmpHome = mkdtempSync(join(tmpdir(), "clerk-help-home-"));
    tmpCwd = mkdtempSync(join(tmpdir(), "clerk-help-cwd-"));
    process.env.HOME = tmpHome;
    process.chdir(tmpCwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  test("shows the tip when no skill is installed anywhere", () => {
    const help = renderHelp();
    expect(help).toContain(TIP_SUBSTR);
    expect(help).toContain("clerk skill install");
  });

  for (const dir of STANDARD_AGENT_DIRS) {
    test(`hides the tip when ${dir}/skills/clerk-cli/SKILL.md exists under HOME`, () => {
      const target = join(tmpHome, dir, "skills/clerk-cli");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "SKILL.md"), "ok");
      expect(renderHelp()).not.toContain(TIP_SUBSTR);
    });

    test(`hides the tip when ${dir}/skills/clerk-cli/SKILL.md exists under cwd`, () => {
      const target = join(tmpCwd, dir, "skills/clerk-cli");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "SKILL.md"), "ok");
      expect(renderHelp()).not.toContain(TIP_SUBSTR);
    });
  }

  for (const rel of EXTRA_REL_PATHS) {
    test(`hides the tip when ${rel} exists under cwd`, () => {
      const full = join(tmpCwd, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, "ok");
      expect(renderHelp()).not.toContain(TIP_SUBSTR);
    });
  }
});
