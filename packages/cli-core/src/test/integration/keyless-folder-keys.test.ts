/**
 * Commands that run on the folder's secret key read it the way `clerk link`
 * and the unlinked-folder advice do (`readFolderKeys`): in the detected
 * framework's env load order, never pairing a plain key with the SDK keyless
 * file's other key, and never guessing when the files disagree.
 *
 * Each test names its credential; the harness sets both a stored session and
 * CLERK_PLATFORM_API_KEY by default. Every run goes through `run`, which fails
 * the test if a secret key or claim token from the folder reaches the output.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import * as localKeys from "../../lib/local-keys.ts";
import {
  clerk,
  http,
  mockState,
  publishableKeyFor,
  useIntegrationTestHarness,
  type CLIResult,
} from "./lib/harness.ts";
import { useCleanClerkKeyEnv, useSyntheticShellClerkKeys } from "../lib/clerk-key-env.ts";

const h = useIntegrationTestHarness();

useSyntheticShellClerkKeys();
useCleanClerkKeyEnv();

const SECRET_KEY = "sk_test_folder_app";
const SDK_SECRET_KEY = "sk_test_sdk_app";
const SDK_CLAIM_TOKEN = "claim_token_sdk";
const FOLDER_PK = publishableKeyFor("folder-app.clerk.accounts.dev");
const SDK_PK = publishableKeyFor("sdk-app.clerk.accounts.dev");

const write = (file: string, content: string) => Bun.write(join(h.tempDir, file), content);
const useFramework = (dep: string) =>
  write("package.json", JSON.stringify({ name: "my-app", dependencies: { [dep]: "1.0.0" } }));
const writeSdkFile = () =>
  write(
    ".clerk/.tmp/keyless.json",
    JSON.stringify({
      publishableKey: SDK_PK,
      secretKey: SDK_SECRET_KEY,
      claimUrl: `https://dashboard.clerk.com/apps/claim?token=${SDK_CLAIM_TOKEN}`,
    }),
  );

async function run(...args: string[]): Promise<CLIResult> {
  const result = await clerk.raw(...args);
  const printed = `${result.stdout}\n${result.stderr}`;
  for (const secret of [SECRET_KEY, SDK_SECRET_KEY, SDK_CLAIM_TOKEN]) {
    expect(printed).not.toContain(secret);
  }
  return result;
}

function signOut(): void {
  delete process.env.CLERK_PLATFORM_API_KEY;
  mockState.storedToken = null;
}

const stderr = (result: CLIResult) => Bun.stripANSI(result.stderr);

function agentError(result: CLIResult): { code: string; message: string } {
  const printed = stderr(result);
  return (
    JSON.parse(printed.slice(printed.search(/\{\s*"error"/))) as {
      error: { code: string; message: string };
    }
  ).error;
}

beforeEach(() => {
  // Every instance's domains match both publishable keys, so no pair here is a mismatch.
  http.stub(async (url) => {
    const { pathname } = new URL(url);
    if (pathname === "/v1/instance") {
      return Response.json({ id: "ins_folder", environment_type: "development" });
    }
    if (pathname === "/v1/domains") {
      return Response.json({
        data: [
          { frontend_api_url: "https://folder-app.clerk.accounts.dev" },
          { frontend_api_url: "https://sdk-app.clerk.accounts.dev" },
        ],
      });
    }
    return Response.json({ errors: [{ message: `unexpected ${url}` }] }, { status: 404 });
  });
});

// Next.js loads `.env.development.local` first in development.
describe("a Next.js folder with keys only in .env.development.local", () => {
  beforeEach(async () => {
    signOut();
    await useFramework("next");
    await write(
      ".env.development.local",
      `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${FOLDER_PK}\nCLERK_SECRET_KEY=${SECRET_KEY}\n`,
    );
  });

  test("whoami reports the instance the key reaches, and the key's file", async () => {
    const result = await run("whoami");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ins_folder");
    expect(stderr(result)).toContain("secret key from `.env.development.local`");
  });

  test("env pull copies both keys from that file", async () => {
    const result = await run("env", "pull", "--file", "pulled.env");
    const pulled = await Bun.file(join(h.tempDir, "pulled.env")).text();

    expect(result.exitCode).toBe(0);
    expect(stderr(result)).toContain("keys from `.env.development.local` written to pulled.env");
    expect(pulled).toContain(`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${FOLDER_PK}`);
    expect(pulled).toContain(`CLERK_SECRET_KEY=${SECRET_KEY}`);
  });
});

// The SDK writes its keyless file only when nothing else configures Clerk, so
// a plain key means the app runs on plain keys: the SDK file's publishable key
// is another app's.
describe("a plain secret key next to an SDK keyless file", () => {
  beforeEach(async () => {
    signOut();
    await write(".env", `CLERK_SECRET_KEY=${SECRET_KEY}\n`);
    await writeSdkFile();
  });

  test("whoami pairs no publishable key with the plain secret key", async () => {
    const result = await run("whoami", "--json");
    const report = JSON.parse(result.stdout) as { accountless: { publishableKey: string | null } };

    expect(report.accountless.publishableKey).toBeNull();
  });

  test("env pull writes only the secret key and says the publishable key is missing", async () => {
    const result = await run("env", "pull", "--file", "pulled.env");
    const pulled = await Bun.file(join(h.tempDir, "pulled.env")).text();

    expect(pulled).toContain(`CLERK_SECRET_KEY=${SECRET_KEY}`);
    expect(pulled).not.toContain(SDK_PK);
    expect(stderr(result)).toContain("No publishable key found locally.");
  });
});

// Nuxt loads only `.env`, so a key in `.env.local` isn't one the app runs on.
describe("a Nuxt folder whose secret key is only in .env.local", () => {
  beforeEach(async () => {
    await useFramework("nuxt");
    await write(".env.local", `NUXT_CLERK_SECRET_KEY=${SECRET_KEY}\n`);
  });

  test("with an SDK keyless file, doctor names the SDK file's app, never the .env.local key", async () => {
    signOut();
    await writeSdkFile();

    const result = await run("doctor", "--json");
    const checks = JSON.parse(result.stdout) as { name: string; message: string }[];
    const loggedIn = checks.find((check) => check.name === "Logged in")!;

    expect(loggedIn.message).toContain("unclaimed accountless application");
    expect(loggedIn.message).toContain("secret key from `.clerk/.tmp/keyless.json`");
    expect(loggedIn.message).not.toContain(".env.local");
  });

  test("enable billing doesn't run on the .env.local key: the folder isn't linked", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;

    const error = agentError(await run("--mode", "agent", "enable", "billing"));

    expect(error.code).toBe("not_linked");
    expect(error.message).toStartWith("No Clerk project linked to this directory.");
    expect(error.message).not.toContain("Billing can only be configured");
  });
});

// With no framework detected, no load order says which file the app loads.
describe("plain keys whose .env and .env.local disagree, no framework", () => {
  beforeEach(async () => {
    await write("package.json", JSON.stringify({ name: "my-app" }));
    await write(".env", `CLERK_PUBLISHABLE_KEY=${FOLDER_PK}\nCLERK_SECRET_KEY=${SECRET_KEY}\n`);
    await write(
      ".env.local",
      `CLERK_PUBLISHABLE_KEY=${SDK_PK}\nCLERK_SECRET_KEY=${SDK_SECRET_KEY}\n`,
    );
  });

  test("env pull doesn't guess a key: not_linked, with the couldn't-tell advice", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;

    const error = agentError(await run("--mode", "agent", "env", "pull"));

    expect(error.code).toBe("not_linked");
    expect(error.message).toContain("hold different Clerk");
    expect(await Bun.file(join(h.tempDir, ".env.local")).text()).toContain(SDK_PK);
  });
});

// The SDK writes its keyless file only when nothing else configures Clerk, so
// its secret key isn't the app's next to a plain publishable key.
describe("a plain publishable key next to an SDK keyless file", () => {
  beforeEach(async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    await write(".env", `CLERK_PUBLISHABLE_KEY=${FOLDER_PK}\n`);
    await writeSdkFile();
  });

  test("enable billing: not_linked, and no request carries the SDK file's secret key", async () => {
    const authorizations: string[] = [];
    http.stub(async (url, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({ errors: [{ message: `unexpected ${url}` }] }, { status: 404 });
    });

    const error = agentError(await run("--mode", "agent", "enable", "billing"));

    expect(error.code).toBe("not_linked");
    expect(authorizations.filter((header) => header.includes(SDK_SECRET_KEY))).toEqual([]);
  });
});

// A rejecting spy stands in for the unreadable file: chmod doesn't stop root in CI.
describe("a Next.js folder whose .env.development.local can't be read", () => {
  beforeEach(async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    await useFramework("next");
    spyOn(localKeys, "readFolderKeys").mockRejectedValue(
      Object.assign(new Error("EACCES: permission denied, open '.env.development.local'"), {
        code: "EACCES",
      }),
    );
  });

  afterEach(() => {
    (localKeys.readFolderKeys as unknown as { mockRestore: () => void }).mockRestore();
  });

  test("doctor: no check crashes, and the not-linked check names the unreadable file", async () => {
    const result = await run("doctor", "--json");
    const checks = JSON.parse(result.stdout) as {
      name: string;
      message: string;
      remedy?: string;
      crashed?: boolean;
    }[];
    const linked = checks.find((check) => check.name === "Project linked")!;

    expect(checks.filter((check) => check.crashed)).toEqual([]);
    expect(linked.remedy).toStartWith(
      "The CLI couldn't read this folder's env files (EACCES: permission denied, open '.env.development.local').",
    );
  });
});
