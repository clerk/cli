/**
 * Signs a new `+clerk_test` user up through the Frontend API of the test
 * application's development instance, as a browser would. Creating a user
 * through the Backend API runs no sign-up flow, so this is how an E2E test gets
 * a sign-up log group: the sign-up's ID is the group's ID.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { log } from "./logger.ts";

const CLI_PATH = join(import.meta.dir, "../../../packages/cli-core/src/cli.ts");
/** The code FAPI accepts for a `+clerk_test` email address. */
const TEST_CODE = "424242";

export type FapiSignUp = {
  id: string;
  status: string;
  unverified_fields?: string[];
  created_user_id?: string | null;
};

async function cliJson<T>(configDir: string, args: string[]): Promise<T> {
  const result = await Bun.$`bun ${CLI_PATH} ${args}`
    .env({ ...process.env, CLERK_CONFIG_DIR: configDir, CLERK_TELEMETRY_DISABLED: "1" })
    .nothrow()
    .quiet();
  if (result.exitCode !== 0) {
    throw new Error(
      `\`clerk ${args.join(" ")}\` exited ${result.exitCode}: ${result.stderr.toString().trim()}`,
    );
  }
  return JSON.parse(result.stdout.toString()) as T;
}

/** The development instance's Frontend API host, from its publishable key. */
async function fapiHost(configDir: string, appId: string): Promise<string> {
  const apps = await cliJson<
    Array<{
      application_id: string;
      instances: Array<{ environment_type: string; publishable_key: string }>;
    }>
  >(configDir, ["apps", "list", "--json"]);
  const instance = apps
    .find((app) => app.application_id === appId)
    ?.instances.find((candidate) => candidate.environment_type === "development");
  if (!instance) throw new Error(`No development instance found for ${appId}.`);
  // pk_test_<base64 of "<host>$">. Decoded here rather than through the CLI's
  // decodePublishableKey, whose module graph needs the CLI's build-time globals.
  const encoded = instance.publishable_key.replace(/^pk_(test|live)_/, "");
  return atob(encoded).replace(/\$$/, "");
}

/**
 * Creates a sign-up with an email and password and verifies the email with the
 * `+clerk_test` code, using a dev browser token and a testing token so bot
 * protection lets it through. `onCreated` gets the sign-up as soon as it
 * exists, so a caller keeps its ID even if finishing the sign-up fails.
 */
export async function signUpThroughFapi(
  configDir: string,
  appId: string,
  onCreated?: (signUp: FapiSignUp) => void,
): Promise<FapiSignUp> {
  const host = await fapiHost(configDir, appId);
  const { token: testingToken } = await cliJson<{ token: string }>(configDir, [
    "api",
    "/testing_tokens",
    "-X",
    "POST",
    "--yes",
    "--app",
    appId,
  ]);

  const devBrowser = await fetch(`https://${host}/v1/dev_browser`, { method: "POST" });
  if (!devBrowser.ok) throw new Error(`POST /v1/dev_browser: ${devBrowser.status}`);
  const { token: devBrowserToken } = (await devBrowser.json()) as { token: string };

  const post = async (path: string, form: Record<string, string>): Promise<FapiSignUp> => {
    const url = new URL(`https://${host}/v1${path}`);
    url.searchParams.set("__clerk_db_jwt", devBrowserToken);
    url.searchParams.set("__clerk_testing_token", testingToken);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`POST ${path}: ${response.status} ${text.slice(0, 500)}`);
    return (JSON.parse(text) as { response: FapiSignUp }).response;
  };

  const hex = randomBytes(8).toString("hex");
  let signUp = await post("/client/sign_ups", {
    email_address: `${hex}+clerk_test@clerkcookie.com`,
    password: `Test${hex}!1`,
  });
  onCreated?.(signUp);
  log(`sign-up created: ${signUp.id} (${signUp.status})`);

  if (
    signUp.status === "missing_requirements" &&
    signUp.unverified_fields?.includes("email_address")
  ) {
    await post(`/client/sign_ups/${signUp.id}/prepare_verification`, { strategy: "email_code" });
    signUp = await post(`/client/sign_ups/${signUp.id}/attempt_verification`, {
      strategy: "email_code",
      code: TEST_CODE,
    });
    log(`sign-up verified: ${signUp.id} (${signUp.status})`);
  }
  return signUp;
}
