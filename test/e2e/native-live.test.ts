import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * This journey creates and deletes a disposable production Clerk application,
 * so it is intentionally excluded from the default E2E suite. Run it with:
 *
 * CLERK_E2E_NATIVE_LIVE=1 bun run test:e2e:op -- \
 *   -t "disposable native iOS application through production"
 */
const LIVE_NATIVE_E2E = process.env.CLERK_E2E_NATIVE_LIVE === "1";
const liveTest = LIVE_NATIVE_E2E ? test : test.skip;
const CLI_PATH = join(import.meta.dir, "../../packages/cli-core/src/cli.ts");
const IOS_FIXTURE = join(import.meta.dir, "fixtures/ios");
const BUNDLE_IDENTIFIER = "com.example.MyApp";
const APP_ID_PREFIX = "LEGACY1234";

type CreatedApplication = {
  applicationId: string;
  instances: unknown[];
};

type DevelopmentInstance = {
  instance_id: string;
  environment_type: string;
};

type DoctorResult = {
  name: string;
  status: "pass" | "warn" | "fail";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function platformURL(path: string): URL {
  return new URL(path, process.env.CLERK_PLATFORM_API_URL ?? "https://api.clerk.com");
}

async function platformRequest(
  apiKey: string,
  path: string,
  init: { method?: string; body?: Record<string, unknown> } = {},
): Promise<Response> {
  return fetch(platformURL(path), {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function preflightApplicationDeletion(apiKey: string, protectedApplicationId: string) {
  let missingApplicationId = "";
  do {
    missingApplicationId = `app_${randomUUID().replaceAll("-", "").slice(0, 25)}`;
  } while (missingApplicationId === protectedApplicationId);

  const lookup = await platformRequest(apiKey, `/v1/platform/applications/${missingApplicationId}`);
  if (lookup.status !== 404) {
    throw new Error(
      `Native live E2E cleanup preflight could not prove its disposable application ID was absent (GET returned ${lookup.status}); no application was created.`,
    );
  }

  const deletion = await platformRequest(
    apiKey,
    `/v1/platform/applications/${missingApplicationId}`,
    { method: "DELETE" },
  );
  if (deletion.status !== 404) {
    throw new Error(
      `Native live E2E requires applications:delete before it creates state (preflight returned ${deletion.status}); no application was created.`,
    );
  }
}

async function createDisposableApplication(apiKey: string): Promise<CreatedApplication> {
  const response = await platformRequest(apiKey, "/v1/platform/applications", {
    method: "POST",
    body: {
      name: `CLI Native Live E2E ${Date.now()}`,
      from_source: "cli",
    },
  });
  if (!response.ok) {
    throw new Error(`Disposable Clerk application creation failed (${response.status}).`);
  }

  const value: unknown = await response.json();
  if (
    !isRecord(value) ||
    typeof value.application_id !== "string" ||
    !Array.isArray(value.instances)
  ) {
    throw new Error("Disposable Clerk application creation returned an invalid response.");
  }
  return { applicationId: value.application_id, instances: value.instances };
}

function developmentInstance(instances: unknown[]): DevelopmentInstance | undefined {
  for (const value of instances) {
    if (
      isRecord(value) &&
      value.environment_type === "development" &&
      typeof value.instance_id === "string"
    ) {
      return {
        instance_id: value.instance_id,
        environment_type: value.environment_type,
      };
    }
  }
  return undefined;
}

async function cleanupDisposableApplication(
  apiKey: string,
  applicationId: string,
  protectedApplicationId: string,
): Promise<void> {
  if (applicationId === protectedApplicationId) {
    throw new Error(
      `Refusing to delete protected CLERK_CLI_TEST_APP_ID ${applicationId}; disposable cleanup was not confirmed.`,
    );
  }

  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await platformRequest(apiKey, `/v1/platform/applications/${applicationId}`, {
        method: "DELETE",
      });
      lastStatus = response.status;
      if (response.status === 200 || response.status === 404) return;
    } catch {
      // A later attempt can still confirm cleanup without exposing transport details.
    }
    await Bun.sleep(250 * attempt);
  }

  throw new Error(
    `Cleanup for disposable Clerk application ${applicationId} was not confirmed${lastStatus ? ` (last status ${lastStatus})` : ""}. Delete it manually before rerunning this test.`,
  );
}

async function directoryDigest(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  async function visit(directory: string, prefix = ""): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!prefix && entry.name === ".git") continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Native live E2E cannot fingerprint non-regular path ${relativePath}.`);
      }
      const bytes = await Bun.file(absolutePath).arrayBuffer();
      result[relativePath] = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    }
  }

  await visit(root);
  return result;
}

function cliEnvironment(configDir: string, apiKey: string): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    CLERK_CONFIG_DIR: configDir,
    CLERK_PLATFORM_API_KEY: apiKey,
    CLERK_TELEMETRY_DISABLED: "1",
    NO_COLOR: "1",
  };
  delete environment.CLERK_CLI_TEST_APP_ID;
  return environment;
}

async function runCLI(
  projectDir: string,
  configDir: string,
  apiKey: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI_PATH, "--mode", "agent", ...args], {
    cwd: projectDir,
    env: cliEnvironment(configDir, apiKey),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function expectSuccessfulCLI(
  label: string,
  projectDir: string,
  configDir: string,
  apiKey: string,
  args: string[],
) {
  const result = await runCLI(projectDir, configDir, apiKey, args);
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${result.exitCode}.`);
  }
  return result;
}

async function readJSONResponse(apiKey: string, path: string): Promise<unknown> {
  const response = await platformRequest(apiKey, path);
  if (!response.ok) throw new Error(`Platform verification request failed (${response.status}).`);
  return response.json();
}

liveTest(
  "clerk init and doctor reconcile a disposable native iOS application through production",
  async () => {
    const apiKey = requireEnvironment("CLERK_PLATFORM_API_KEY");
    const protectedApplicationId = requireEnvironment("CLERK_CLI_TEST_APP_ID");
    const tmp = await realpath(tmpdir());
    const projectDir = await mkdtemp(join(tmp, "clerk-e2e-native-live-"));
    const configDir = await mkdtemp(join(tmp, "clerk-e2e-native-live-config-"));
    let disposableApplicationId: string | undefined;
    let journeyError: unknown;
    let cleanupError: unknown;

    try {
      await preflightApplicationDeletion(apiKey, protectedApplicationId);
      const application = await createDisposableApplication(apiKey);
      disposableApplicationId = application.applicationId;
      if (disposableApplicationId === protectedApplicationId) {
        throw new Error(
          "Platform returned CLERK_CLI_TEST_APP_ID for disposable creation; refusing to continue.",
        );
      }
      const instance = developmentInstance(application.instances);
      if (!instance) {
        throw new Error(
          `Disposable Clerk application ${disposableApplicationId} has no development instance.`,
        );
      }

      await cp(IOS_FIXTURE, projectDir, { recursive: true });
      const initArgs = [
        "init",
        "--yes",
        "--no-skills",
        "--target",
        "MyApp",
        "--app",
        disposableApplicationId,
        "--app-id-prefix",
        APP_ID_PREFIX,
        "--sign-in-with-apple",
      ];
      await expectSuccessfulCLI(
        "Initial native clerk init",
        projectDir,
        configDir,
        apiKey,
        initArgs,
      );

      const nativeBase = `/v1/platform/applications/${disposableApplicationId}/instances/${instance.instance_id}`;
      const nativeSettings = await readJSONResponse(apiKey, `${nativeBase}/native_settings`);
      expect(nativeSettings).toEqual({ object: "native_settings", api_enabled: true });

      const registrations = await readJSONResponse(apiKey, `${nativeBase}/native_applications/ios`);
      expect(Array.isArray(registrations)).toBe(true);
      const matchingRegistrations = (registrations as unknown[]).filter(
        (value) =>
          isRecord(value) &&
          value.app_id_prefix === APP_ID_PREFIX &&
          value.bundle_id === BUNDLE_IDENTIFIER,
      );
      expect(matchingRegistrations).toHaveLength(1);

      const entitlements = await Bun.file(join(projectDir, "MyApp", "MyApp.entitlements")).text();
      expect(entitlements.match(/<key>com\.apple\.developer\.applesignin<\/key>/g)).toHaveLength(1);
      expect(entitlements).toMatch(
        /<key>com\.apple\.developer\.applesignin<\/key>\s*<array>\s*<string>Default<\/string>\s*<\/array>/,
      );

      const appleConfig = await readJSONResponse(
        apiKey,
        `${nativeBase}/config?keys=connection_oauth_apple`,
      );
      expect(isRecord(appleConfig)).toBe(true);
      const appleConnection = isRecord(appleConfig)
        ? appleConfig.connection_oauth_apple
        : undefined;
      expect(appleConnection).toMatchObject({
        enabled: true,
        authenticatable: true,
        bundle_id: BUNDLE_IDENTIFIER,
      });

      const firstDigest = await directoryDigest(projectDir);
      await expectSuccessfulCLI(
        "Repeated native clerk init",
        projectDir,
        configDir,
        apiKey,
        initArgs,
      );
      expect(await directoryDigest(projectDir)).toEqual(firstDigest);

      const registrationsAfterRerun = await readJSONResponse(
        apiKey,
        `${nativeBase}/native_applications/ios`,
      );
      expect(Array.isArray(registrationsAfterRerun)).toBe(true);
      expect(
        (registrationsAfterRerun as unknown[]).filter(
          (value) =>
            isRecord(value) &&
            value.app_id_prefix === APP_ID_PREFIX &&
            value.bundle_id === BUNDLE_IDENTIFIER,
        ),
      ).toHaveLength(1);

      const doctor = await expectSuccessfulCLI(
        "Native clerk doctor",
        projectDir,
        configDir,
        apiKey,
        ["doctor", "--json", "--target", "MyApp"],
      );
      let doctorResults: unknown;
      try {
        doctorResults = JSON.parse(doctor.stdout);
      } catch {
        throw new Error("Native clerk doctor did not return valid JSON.");
      }
      if (!Array.isArray(doctorResults)) {
        throw new Error("Native clerk doctor returned an invalid JSON result.");
      }
      const checks = doctorResults.filter(
        (value): value is DoctorResult =>
          isRecord(value) &&
          typeof value.name === "string" &&
          (value.status === "pass" || value.status === "warn" || value.status === "fail"),
      );
      expect(checks.filter((check) => check.status === "fail")).toEqual([]);
      for (const name of [
        "iOS: Native Application",
        "iOS: Sign in with Apple entitlement",
        "iOS: Clerk Sign in with Apple",
      ]) {
        expect(checks.find((check) => check.name === name)?.status).toBe("pass");
      }
    } catch (error) {
      journeyError = error;
    } finally {
      if (disposableApplicationId) {
        try {
          await cleanupDisposableApplication(
            apiKey,
            disposableApplicationId,
            protectedApplicationId,
          );
        } catch (error) {
          cleanupError = error;
        }
      }
      await Promise.all([
        rm(projectDir, { recursive: true, force: true }),
        rm(configDir, { recursive: true, force: true }),
      ]);
    }
    if (cleanupError) throw cleanupError;
    if (journeyError) throw journeyError;
  },
  { timeout: 240_000 },
);
