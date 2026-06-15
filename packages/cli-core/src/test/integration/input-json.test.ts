/**
 * --input-json expands JSON objects into argv flags
 * Any command can accept options as JSON for agent-friendly invocation.
 */

import { test, expect, beforeEach } from "bun:test";
import {
  useIntegrationTestHarness,
  http,
  setProfile,
  clerk,
  getInstance,
  MOCK_APP,
} from "./lib/harness.ts";
import { join } from "node:path";

useIntegrationTestHarness();

const devInstance = getInstance(MOCK_APP, "development");

beforeEach(async () => {
  await setProfile("github.com/test/project", {
    workspaceId: "",
    appId: MOCK_APP.application_id,
    instances: { development: devInstance.instance_id },
  });
});

test("init --input-json passes options through Commander pipeline", async () => {
  // {"yes":true} expands to --yes; init still fails (no framework in test cwd) but
  // the "unknown option" path would surface a different stderr if Commander rejected
  // the expanded flag, so this proves expansion + acceptance.
  const result = await clerk.raw("init", "--input-json", '{"yes":true}');
  expect(result.stderr).not.toContain("unknown option");
});

test("explicit CLI flags override --input-json values", async () => {
  // --input-json sets mode=human, but --mode agent later overrides. The post-parse
  // mode is observable via the structured-JSON error format that agent mode emits.
  const result = await clerk.raw("init", "--input-json", '{"mode":"human"}', "--mode", "agent");
  expect(result.exitCode).not.toBe(0);
  // Agent mode emits structured JSON to stderr; human mode emits plain text.
  const parsed = JSON.parse(result.stderr);
  expect(parsed.error).toBeDefined();
});

test("doctor --input-json with json:true outputs JSON", async () => {
  // doctor may exit non-zero if checks fail, so use clerk.raw
  const result = await clerk.raw("doctor", "--input-json", '{"json":true}');
  // doctor --json outputs a JSON array of check results to stdout
  const parsed = JSON.parse(result.stdout);
  expect(Array.isArray(parsed)).toBe(true);
});

test("config patch --input-json with dryRun shows preview", async () => {
  // config patch now GETs current config to compute the diff, even on dry runs.
  http.stub(async () => {
    return new Response(JSON.stringify({ session: { lifetime: 604800 } }), { status: 200 });
  });

  const { stderr } = await clerk(
    "--mode",
    "human",
    "config",
    "patch",
    "--json",
    '{"session":{"lifetime":3600}}',
    "--input-json",
    '{"dryRun":true}',
  );
  expect(stderr).toContain("[dry-run]");
});

test("rejects invalid JSON", async () => {
  const result = await clerk.raw("init", "--input-json", "not-json");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Invalid JSON");
});

test("rejects JSON array", async () => {
  const result = await clerk.raw("init", "--input-json", "[1,2,3]");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("must be a JSON object");
});

test("rejects nested objects", async () => {
  const result = await clerk.raw("init", "--input-json", '{"nested":{"key":"value"}}');
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Nested objects are not supported");
});

test("rejects missing value after --input-json", async () => {
  const result = await clerk.raw("init", "--input-json");
  expect(result.exitCode).not.toBe(0);
});

test("rejects unknown options via Commander", async () => {
  // Commander's own unknown-option error
  const result = await clerk.raw("init", "--input-json", '{"totallyFakeOption":"yes"}');
  expect(result.exitCode).not.toBe(0);
});

test("empty JSON object is a no-op", async () => {
  // Empty JSON adds no flags. doctor is non-side-effecting and returns JSON
  // when --json is in argv elsewhere — here we just need a clean exit.
  const result = await clerk.raw("doctor", "--input-json", "{}", "--json");
  const parsed = JSON.parse(result.stdout);
  expect(Array.isArray(parsed)).toBe(true);
});

test("@file.json reads options from a temp file", async () => {
  const filePath = join(process.cwd(), "input-opts.json");
  await Bun.write(filePath, '{"json":true}');

  // doctor may exit non-zero if checks fail, so use clerk.raw
  const result = await clerk.raw("doctor", "--input-json", `@${filePath}`);
  const parsed = JSON.parse(result.stdout);
  expect(Array.isArray(parsed)).toBe(true);
});

test("@file.json errors on missing file", async () => {
  const result = await clerk.raw("init", "--input-json", "@/tmp/nonexistent-clerk-test-file.json");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("File not found");
});

test("camelCase keys are converted to kebab-case flags", async () => {
  // dryRun → --dry-run, which config patch understands
  http.stub(async () => {
    return new Response(JSON.stringify({ session: { lifetime: 604800 } }), { status: 200 });
  });

  const { stderr } = await clerk(
    "config",
    "patch",
    "--json",
    '{"session":{"lifetime":3600}}',
    "--input-json",
    '{"dryRun":true,"yes":true}',
  );
  expect(stderr).toContain("[dry-run]");
});

test("Commander rejects invalid choice values from --input-json", async () => {
  // --framework only accepts known framework names
  const result = await clerk.raw(
    "--mode",
    "agent",
    "init",
    "--input-json",
    '{"framework":"invalid-framework-name","yes":true}',
  );
  expect(result.exitCode).not.toBe(0);
});

test("api command with positional args + JSON options", async () => {
  // Positional arg /users should be preserved alongside expanded flags
  const { stderr } = await clerk(
    "api",
    "/users",
    "--secret-key",
    devInstance.secret_key!,
    "--input-json",
    '{"dryRun":true}',
  );
  expect(http.requests.length).toBe(0);
  expect(stderr).toContain("[dry-run]");
  expect(stderr).toContain("/users");
});

test("apps list --json via --input-json", async () => {
  http.mock({ "/applications": [] });
  const { stdout } = await clerk("apps", "list", "--input-json", '{"json":true}');
  const parsed = JSON.parse(stdout);
  expect(Array.isArray(parsed)).toBe(true);
});

test("config pull with array keys via --input-json", async () => {
  // Nested subcommand (config → pull) with variadic --keys option
  // Array expansion should produce --keys auth_email --keys session
  http.stub(async () => {
    return new Response(JSON.stringify({ session: { lifetime: 604800 } }), { status: 200 });
  });

  const { stdout } = await clerk(
    "config",
    "pull",
    "--input-json",
    // json:true so stdout is JSON (default output is now YAML)
    '{"keys":["auth_email","session"],"json":true}',
  );
  const parsed = JSON.parse(stdout);
  expect(parsed).toBeDefined();
});

test("config schema with array keys via --input-json", async () => {
  // Another nested subcommand (config → schema) exercising array expansion
  http.stub(async () => {
    return new Response(JSON.stringify({ type: "object", properties: {} }), { status: 200 });
  });

  const { stdout } = await clerk("config", "schema", "--input-json", '{"keys":["session"]}');
  const parsed = JSON.parse(stdout);
  expect(parsed).toBeDefined();
});

test("--input-json before nested subcommand errors on non-root flags", async () => {
  // Expansion happens at argv position — before the subcommand, flags land on
  // the root program. Non-root flags like --json are unknown at the root level.
  const result = await clerk.raw("--input-json", '{"json":true}', "apps", "list");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("unknown option");
});

test("--input-json after nested subcommand targets that subcommand", async () => {
  // Same JSON placed after the subcommand routes --json to `apps list`, which accepts it.
  http.mock({ "/applications": [] });
  const { stdout } = await clerk("apps", "list", "--input-json", '{"json":true}');
  const parsed = JSON.parse(stdout);
  expect(Array.isArray(parsed)).toBe(true);
});

test("noSkills negated boolean via --input-json", async () => {
  // noSkills:true → --no-skills. Init will exit non-zero (no framework in test cwd)
  // but Commander would surface "unknown option" before the action runs if the
  // negated flag wasn't accepted.
  const result = await clerk.raw("init", "--input-json", '{"yes":true,"noSkills":true}');
  expect(result.stderr).not.toContain("unknown option");
});

test("--input-json is registered as a global option", async () => {
  // --input-json before the subcommand expands to flags at the root-program level.
  // --mode is a root-level flag, so this works; subcommand-specific flags would not.
  // doctor exits non-zero in this harness; the structured-JSON error format on
  // stderr is the agent-mode signature, which proves --mode agent was applied.
  const result = await clerk.raw("--input-json", '{"mode":"agent"}', "doctor", "--json");
  expect(result.exitCode).not.toBe(0);
  const parsed = JSON.parse(result.stderr);
  expect(parsed.error).toBeDefined();
});

test("structured JSON error in agent mode for invalid JSON", async () => {
  const result = await clerk.raw("--mode", "agent", "init", "--input-json", "{bad}");
  expect(result.exitCode).not.toBe(0);
  const parsed = JSON.parse(result.stderr);
  expect(parsed.error.code).toBe("invalid_json");
});

test("structured JSON error in agent mode for file not found", async () => {
  const result = await clerk.raw(
    "--mode",
    "agent",
    "init",
    "--input-json",
    "@/tmp/does-not-exist-clerk.json",
  );
  expect(result.exitCode).not.toBe(0);
  const parsed = JSON.parse(result.stderr);
  expect(parsed.error.code).toBe("file_not_found");
});

test("structured JSON error in agent mode for nested objects", async () => {
  const result = await clerk.raw(
    "--mode",
    "agent",
    "init",
    "--input-json",
    '{"nested":{"key":"value"}}',
  );
  expect(result.exitCode).not.toBe(0);
  const parsed = JSON.parse(result.stderr);
  expect(parsed.error.code).toBe("invalid_json");
});
