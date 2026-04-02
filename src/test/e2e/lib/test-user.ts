import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { log } from "./logger.ts";

const CLI_PATH = join(import.meta.dir, "../../../../packages/cli-core/src/cli.ts");

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

/** Build env for CLI commands with the secret key from the fixture's env files. */
function clerkEnv(configDir: string, secretKey: string): Record<string, string | undefined> {
  return {
    ...process.env,
    CLERK_CONFIG_DIR: configDir,
    CLERK_SECRET_KEY: secretKey,
  };
}

/**
 * Create a test user via `clerk api`. Uses +clerk_test email suffix so
 * OTP code 424242 works without real email delivery.
 */
export async function createTestUser(
  configDir: string,
  secretKey: string,
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

  const result = await Bun.$`bun ${CLI_PATH} api /users -X POST -d ${body}`
    .env(clerkEnv(configDir, secretKey))
    .quiet()
    .nothrow();

  if (result.exitCode !== 0) {
    throw new Error(`Failed to create test user:\n${result.stderr.toString()}`);
  }

  const user = JSON.parse(result.stdout.toString());
  log(fixtureName, `test user created: ${user.id}`);

  return { id: user.id, email, password };
}

/** Delete a test user via `clerk api`. Safe to call even if the user doesn't exist. */
export async function deleteTestUser(
  userId: string,
  configDir: string,
  secretKey: string,
  fixtureName: string,
): Promise<void> {
  log(fixtureName, `deleting test user: ${userId}`);

  const result = await Bun.$`bun ${CLI_PATH} api /users/${userId} -X DELETE`
    .env(clerkEnv(configDir, secretKey))
    .quiet()
    .nothrow();

  if (result.exitCode !== 0) {
    log(fixtureName, `warning: failed to delete test user ${userId}: ${result.stderr.toString()}`);
  } else {
    log(fixtureName, `test user deleted: ${userId}`);
  }
}
