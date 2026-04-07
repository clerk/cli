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

const PLAPI_BASE = process.env.CLERK_PLATFORM_API_URL ?? "https://api.clerk.com";
const BAPI_BASE = process.env.CLERK_BACKEND_API_URL ?? "https://api.clerk.com";
const TEST_EMAIL_SUFFIX = "+clerk_test@clerkcookie.com";

async function plapiGet(path: string, apiKey: string): Promise<unknown> {
  const res = await fetch(`${PLAPI_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Platform API ${path} failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function bapiGet(path: string, secretKey: string): Promise<unknown> {
  const res = await fetch(`${BAPI_BASE}${path}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Backend API GET ${path} failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function bapiDelete(path: string, secretKey: string): Promise<boolean> {
  const res = await fetch(`${BAPI_BASE}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  return res.ok;
}

async function main() {
  const platformKey = process.env.CLERK_PLATFORM_API_KEY;
  const appId = process.env.CLERK_CLI_TEST_APP_ID;
  if (!platformKey || !appId) {
    throw new Error("CLERK_PLATFORM_API_KEY and CLERK_CLI_TEST_APP_ID are required");
  }

  // 1. Fetch the app to get the dev instance secret key
  const app = (await plapiGet(`/v1/platform/applications/${appId}`, platformKey)) as {
    instances: { environment_type: string; secret_key?: string }[];
  };
  const devInstance = app.instances?.find((i) => i.environment_type === "development");
  if (!devInstance?.secret_key) {
    throw new Error("No development instance secret key found");
  }

  const secretKey = devInstance.secret_key;

  // 2. List users and find test users
  let offset = 0;
  const limit = 100;
  const testUsers: { id: string; email: string }[] = [];

  while (true) {
    const users = (await bapiGet(`/v1/users?limit=${limit}&offset=${offset}`, secretKey)) as {
      id: string;
      email_addresses: { email_address: string }[];
    }[];

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
    if (await bapiDelete(`/v1/users/${user.id}`, secretKey)) {
      deleted++;
    } else {
      console.error(`Failed to delete ${user.id} (${user.email})`);
    }
  }

  console.log(`Deleted ${deleted}/${testUsers.length} test users.`);
}

main();
