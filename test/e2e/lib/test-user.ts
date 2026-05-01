import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { log } from "./logger.ts";

const CLI_PATH = join(import.meta.dir, "../../../packages/cli-core/src/cli.ts");

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

/**
 * Identifies the target Clerk instance for the test user.
 *
 * - `secretKey`: the existing path used by framework fixtures, which resolve
 *   the secret key from the linked profile's env file. The key is injected
 *   as CLERK_SECRET_KEY in the CLI subprocess env.
 * - `appId`: used by BAPI roundtrip tests that don't run a fixture. The CLI
 *   resolves the secret key per-call via PLAPI using `--app <appId>`. Useful
 *   when the test only has CLERK_CLI_TEST_APP_ID and CLERK_PLATFORM_API_KEY.
 */
export type TestUserTarget = { secretKey: string } | { appId: string };

/** Build env for CLI commands. Only injects CLERK_SECRET_KEY when targeting by key. */
function clerkEnv(configDir: string, target: TestUserTarget): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLERK_CONFIG_DIR: configDir,
  };
  if ("secretKey" in target) env.CLERK_SECRET_KEY = target.secretKey;
  return env;
}

/** Append `--app <appId>` when targeting by app, otherwise nothing. */
function targetArgs(target: TestUserTarget): string[] {
  return "appId" in target ? ["--app", target.appId] : [];
}

/**
 * Create a test user via `clerk users create`. Uses +clerk_test email suffix
 * so OTP code 424242 works without real email delivery. Passes the BAPI body
 * via `-d` because `skip_password_checks` is not a curated flag.
 */
export async function createTestUser(
  configDir: string,
  target: TestUserTarget,
  fixtureName: string,
): Promise<TestUser> {
  const hex = randomBytes(8).toString("hex");
  const email = `${hex}+clerk_test@clerkcookie.com`;
  const password = `Test${hex}!1`;

  const body = JSON.stringify({
    email_address: [email],
    password,
    skip_password_checks: true,
  });

  log(fixtureName, `creating test user: ${email}`);

  const result =
    await Bun.$`bun ${CLI_PATH} users create -d ${body} --json --yes ${targetArgs(target)}`
      .env(clerkEnv(configDir, target))
      .quiet()
      .nothrow();

  if (result.exitCode !== 0) {
    const stdout = result.stdout.toString().trim();
    const stderr = result.stderr.toString().trim();
    const detail = stderr || stdout || "(no output)";
    throw new Error(`Failed to create test user:\n${detail}`);
  }

  const user = JSON.parse(result.stdout.toString());
  log(fixtureName, `test user created: ${user.id}`);

  return { id: user.id, email, password };
}

/** Delete a test user via `clerk api`. Safe to call even if the user doesn't exist. */
export async function deleteTestUser(
  userId: string,
  configDir: string,
  target: TestUserTarget,
  fixtureName: string,
): Promise<void> {
  log(fixtureName, `deleting test user: ${userId}`);

  const result =
    await Bun.$`bun ${CLI_PATH} api /users/${userId} -X DELETE --yes ${targetArgs(target)}`
      .env(clerkEnv(configDir, target))
      .quiet()
      .nothrow();

  if (result.exitCode !== 0) {
    const stdout = result.stdout.toString().trim();
    const stderr = result.stderr.toString().trim();
    const detail = stderr || stdout || "(no output)";
    log(fixtureName, `warning: failed to delete test user ${userId}: ${detail}`);
  } else {
    log(fixtureName, `test user deleted: ${userId}`);
  }
}
