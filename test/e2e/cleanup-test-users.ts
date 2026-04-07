/**
 * Purge stale test users from the Clerk test application.
 *
 * E2E tests create disposable users with the `+clerk_test@clerkcookie.com`
 * email suffix. When CI runs are cancelled or crash, cleanup doesn't run and
 * users accumulate until the dev instance hits its 100-user quota. This script
 * fetches the dev instance secret key via the Platform API, then lists and
 * deletes any users matching the test email pattern.
 *
 * Required env vars: CLERK_PLATFORM_API_KEY, CLERK_CLI_TEST_APP_ID.
 */

import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "../../packages/cli-core/src/cli.ts");
const TEST_EMAIL_SUFFIX = "+clerk_test@clerkcookie.com";

async function main() {
  const platformKey = process.env.CLERK_PLATFORM_API_KEY;
  const appId = process.env.CLERK_CLI_TEST_APP_ID;
  if (!platformKey || !appId) {
    throw new Error("CLERK_PLATFORM_API_KEY and CLERK_CLI_TEST_APP_ID are required");
  }

  const env = { ...process.env, CLERK_PLATFORM_API_KEY: platformKey };

  // 1. Fetch the app to get the dev instance secret key
  const appResult = await Bun.$`bun ${CLI_PATH} api /applications/${appId} --platform --yes`
    .env(env)
    .quiet()
    .nothrow();
  if (appResult.exitCode !== 0) {
    const detail = appResult.stdout.toString().trim() || appResult.stderr.toString().trim();
    throw new Error(`Failed to fetch application: ${detail}`);
  }

  const app = JSON.parse(appResult.stdout.toString());
  const devInstance = app.instances?.find(
    (i: { environment_type: string }) => i.environment_type === "development",
  );
  if (!devInstance?.secret_key) {
    throw new Error("No development instance secret key found");
  }

  const secretKey: string = devInstance.secret_key;
  const bapiEnv = { ...process.env, CLERK_SECRET_KEY: secretKey };

  // 2. List users and find test users
  let offset = 0;
  const limit = 100;
  const testUsers: { id: string; email: string }[] = [];

  while (true) {
    const result = await Bun.$`bun ${CLI_PATH} api /users?limit=${limit}&offset=${offset} --yes`
      .env(bapiEnv)
      .quiet()
      .nothrow();
    if (result.exitCode !== 0) {
      const detail = result.stdout.toString().trim() || result.stderr.toString().trim();
      throw new Error(`Failed to list users: ${detail}`);
    }

    const users: { id: string; email_addresses: { email_address: string }[] }[] = JSON.parse(
      result.stdout.toString(),
    );
    if (users.length === 0) break;

    for (const user of users) {
      const testEmail = user.email_addresses.find((e) =>
        e.email_address.endsWith(TEST_EMAIL_SUFFIX),
      );
      if (testEmail) {
        testUsers.push({ id: user.id, email: testEmail.email_address });
      }
    }

    if (users.length < limit) break;
    offset += limit;
  }

  if (testUsers.length === 0) {
    console.log("No stale test users found.");
    return;
  }

  console.log(`Found ${testUsers.length} stale test user(s). Deleting...`);

  let deleted = 0;
  for (const user of testUsers) {
    const result = await Bun.$`bun ${CLI_PATH} api /users/${user.id} -X DELETE --yes`
      .env(bapiEnv)
      .quiet()
      .nothrow();
    if (result.exitCode === 0) {
      deleted++;
    } else {
      console.error(`Failed to delete ${user.id} (${user.email})`);
    }
  }

  console.log(`Deleted ${deleted}/${testUsers.length} test users.`);
}

main();
