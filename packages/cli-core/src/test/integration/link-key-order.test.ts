/**
 * `clerk link` matches the folder's app by the one publishable key the app
 * loads, following the detected framework's documented env file order. When
 * it can't tell which key that is, it never auto-links: a person chooses from
 * the picker, an agent gets the not-linked stop.
 *
 * Credential: the harness default, a stored session and an API key. Neither
 * changes which key the folder's app loads.
 */

import { beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { Application } from "../../lib/plapi.ts";
import { clerk, http, mockPrompts, readConfig, useIntegrationTestHarness } from "./lib/harness.ts";
import { useCleanClerkKeyEnv, useSyntheticShellClerkKeys } from "../lib/clerk-key-env.ts";

const h = useIntegrationTestHarness();

const PROFILE_KEY = "github.com/test/project";

function app(id: string, publishableKey: string): Application {
  return {
    application_id: id,
    name: `App ${id}`,
    instances: [
      {
        instance_id: `ins_${id}`,
        environment_type: "development",
        publishable_key: publishableKey,
        secret_key: `sk_test_${id}`,
      },
    ],
  };
}

const APP_A = app("app_A", "pk_test_app_a");
const APP_B = app("app_B", "pk_test_app_b");

useSyntheticShellClerkKeys();
useCleanClerkKeyEnv();

beforeEach(() => {
  http.stub(async (url) => {
    const { pathname } = new URL(url);
    if (pathname === "/v1/platform/applications") return Response.json([APP_A, APP_B]);
    for (const known of [APP_A, APP_B]) {
      if (pathname === `/v1/platform/applications/${known.application_id}`) {
        return Response.json(known);
      }
    }
    return Response.json({ errors: [{ message: `unexpected ${url}` }] }, { status: 404 });
  });
});

async function useFramework(dep: string) {
  await Bun.write(
    join(h.tempDir, "package.json"),
    JSON.stringify({ dependencies: { [dep]: "1" } }),
  );
}

async function writeEnv(file: string, line: string) {
  await Bun.write(join(h.tempDir, file), `${line}\n`);
}

async function linkedAppId(): Promise<string | undefined> {
  return (await readConfig()).profiles[PROFILE_KEY]?.appId;
}

test("agent, Next.js: doesn't link .env's app when .env.local, which Next.js loads, holds a key no app has", async () => {
  await useFramework("next");
  await writeEnv(
    ".env",
    `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${APP_A.instances[0]!.publishable_key}`,
  );
  await writeEnv(".env.local", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_no_such_app");

  const result = await clerk.raw("--mode", "agent", "link");

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain('"code":"usage_error"');
  expect(await linkedAppId()).toBeUndefined();
});

test("agent, Vite: links the app whose key is in .env.development, which Vite loads over .env.local", async () => {
  await useFramework("vite");
  await writeEnv(
    ".env.development",
    `VITE_CLERK_PUBLISHABLE_KEY=${APP_A.instances[0]!.publishable_key}`,
  );
  await writeEnv(".env.local", `VITE_CLERK_PUBLISHABLE_KEY=${APP_B.instances[0]!.publishable_key}`);

  await clerk("--mode", "agent", "link");

  expect(await linkedAppId()).toBe(APP_A.application_id);
});

test("agent, no framework detected: files holding different keys stop the link and say why", async () => {
  await writeEnv(".env", `CLERK_PUBLISHABLE_KEY=${APP_A.instances[0]!.publishable_key}`);
  await writeEnv(".env.local", `CLERK_PUBLISHABLE_KEY=${APP_B.instances[0]!.publishable_key}`);

  const result = await clerk.raw("--mode", "agent", "link");

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("Cannot select an application in agent mode.");
  expect(result.stderr).toContain("`.env.local` and `.env` hold different Clerk publishable keys");
  expect(await linkedAppId()).toBeUndefined();
});

test("agent: a Clerk key line the CLI can't read stops the link and says why", async () => {
  await useFramework("next");
  await writeEnv(
    ".env",
    `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${APP_A.instances[0]!.publishable_key}`,
  );
  await writeEnv(
    ".env.local",
    `  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${APP_B.instances[0]!.publishable_key}`,
  );

  const result = await clerk.raw("--mode", "agent", "link");

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("couldn't read the `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` line");
  expect(await linkedAppId()).toBeUndefined();
});

test("person, no framework detected: files holding different keys go straight to the picker, saying why", async () => {
  await writeEnv(".env", `CLERK_PUBLISHABLE_KEY=${APP_A.instances[0]!.publishable_key}`);
  await writeEnv(".env.local", `CLERK_PUBLISHABLE_KEY=${APP_B.instances[0]!.publishable_key}`);
  // The picker's choice; no "Link to this application?" question comes first.
  mockPrompts.search(APP_B.application_id);

  const result = await clerk("link");

  // `log.info` colors backticked words; compare the text a person reads.
  expect(Bun.stripANSI(result.stderr)).toContain(
    "`.env.local` and `.env` hold different Clerk publishable keys",
  );
  expect(await linkedAppId()).toBe(APP_B.application_id);
});
