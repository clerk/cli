import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  convertIOSFixtureToSynchronizedMissingEntitlements,
  createIOSFixture,
  IOS_FIXTURE_IDS,
  treeDigest,
} from "./test-helpers.ts";

const temporaryDirectories: string[] = [];
const cliPath = resolve(import.meta.dir, "../../../cli.ts");
const canonicalSwiftUIFixture = resolve(import.meta.dir, "../../../../../../test/e2e/fixtures/ios");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function isolatedCLIEnvironment(
  configDir: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...Bun.env };

  // The subprocess must not inherit credentials, mode, telemetry opt-outs, or
  // a user's real Clerk config. The fixture's .env remains inspector input,
  // but it is never copied into this explicit process environment.
  for (const key of Object.keys(env)) {
    if (key.includes("CLERK")) delete env[key];
  }
  delete env.CI;
  delete env.DO_NOT_TRACK;
  delete env.NO_UPDATE_NOTIFIER;

  return {
    ...env,
    NO_COLOR: "1",
    CLERK_CONFIG_DIR: configDir,
    CLERK_TELEMETRY_DISABLED: "1",
    ...overrides,
  };
}

async function createIsolatedCLIState(): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), "clerk-ios-cli-config-"));
  temporaryDirectories.push(configDir);
  await Bun.write(
    join(configDir, "config.json"),
    JSON.stringify({
      profiles: {},
      telemetryNoticeShown: true,
      machineUuid: "00000000-0000-4000-8000-000000000000",
    }) + "\n",
  );
  return configDir;
}

async function runCLI(root: string, args: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("clerk init --dry-run", () => {
  test("non-TTY mode emits JSON without network requests or local/global writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-cli-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true });
    const configDir = await createIsolatedCLIState();
    const projectBefore = await treeDigest(root);
    const configBefore = await treeDigest(configDir);
    let requestCount = 0;
    const requestTrap = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requestCount += 1;
        return Response.json({ ok: true });
      },
    });

    try {
      const result = await runCLI(
        root,
        ["init", "--dry-run"],
        isolatedCLIEnvironment(configDir, {
          // Dev builds normally suppress telemetry. Pointing it at the trap
          // makes a leaked global telemetry hook observable.
          CLERK_TELEMETRY_URL: requestTrap.url.href,
          CLERK_TELEMETRY_DISABLED: undefined,
        }),
      );

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({
        schemaVersion: 1,
        mode: "read-only",
        status: "ready",
        inspection: { platform: "ios", selection: { state: "selected", targetName: "MyApp" } },
        plan: { kind: "clerk-ios-setup", status: "ready" },
        nativeReadiness: {
          kind: "clerk-ios-native-readiness",
          remote: {
            status: "not-inspected",
            reason: "dry-run-does-not-read-remote-state",
          },
        },
      });
      expect(result.stdout).not.toContain("CLERK_PUBLISHABLE_KEY=");
      expect(requestCount).toBe(0);
      expect(await treeDigest(root)).toEqual(projectBefore);
      expect(await treeDigest(configDir)).toEqual(configBefore);
    } finally {
      await requestTrap.stop(true);
    }
  });

  test("explicit JSON output stays free of human-mode UI", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-cli-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true });
    const configDir = await createIsolatedCLIState();
    const projectBefore = await treeDigest(root);
    const configBefore = await treeDigest(configDir);

    const result = await runCLI(
      root,
      ["--mode", "human", "init", "--dry-run", "--json"],
      isolatedCLIEnvironment(configDir),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "read-only",
      inspection: { selection: { state: "selected", targetName: "MyApp" } },
    });
    expect(await treeDigest(root)).toEqual(projectBefore);
    expect(await treeDigest(configDir)).toEqual(configBefore);
  });

  test("fresh SwiftUI output advertises direct configuration and environment automation", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-cli-direct-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { clerkSDK: false, includeKey: false });
    const unrelatedKey = `pk_test_${Buffer.from("unrelated-dry-run.clerk.example$").toString("base64")}`;
    await Bun.write(join(root, ".env"), `CLERK_PUBLISHABLE_KEY=${unrelatedKey}\n`);
    const configDir = await createIsolatedCLIState();
    const before = await treeDigest(root);

    const result = await runCLI(
      root,
      ["--mode", "human", "init", "--dry-run", "--json"],
      isolatedCLIEnvironment(configDir),
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    const configure = output.plan.steps.find(
      (step: { id: string }) => step.id === "configure-publishable-key",
    );
    const environment = output.plan.steps.find(
      (step: { id: string }) => step.id === "inject-clerk-environment",
    );
    const associatedDomain = output.plan.steps.find(
      (step: { id: string }) => step.id === "add-associated-domain",
    );
    expect(configure).toMatchObject({ status: "required", automatable: true });
    expect(environment).toMatchObject({ status: "required", automatable: true });
    expect(associatedDomain).toMatchObject({ status: "required", automatable: true });
    expect(output.nativeReadiness.associatedDomain).toMatchObject({
      status: "required",
      automatable: true,
      files: ["MyApp/MyApp.entitlements"],
    });
    expect(output.nativeReadiness.associatedDomain.expectedDomain).toBeUndefined();
    expect(configure.description).toContain("directly");
    expect(result.stdout).not.toContain("LocalSecrets");
    expect(result.stdout).not.toContain("pk_test_");
    expect(await treeDigest(root)).toEqual(before);
  });

  test("explicit AuthView dry-run includes safe direct setup for an import-only core target", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-cli-auth-direct-"));
    temporaryDirectories.push(root);
    await cp(canonicalSwiftUIFixture, root, { recursive: true });
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  var body: some Scene {
    WindowGroup {
      ContentView()
    }
  }
}
`,
    );
    const configDir = await createIsolatedCLIState();
    const before = await treeDigest(root);

    const result = await runCLI(
      root,
      ["--mode", "human", "init", "--dry-run", "--json", "--prebuilt-auth-ui"],
      isolatedCLIEnvironment(configDir),
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    const configure = output.plan.steps.find(
      (step: { id: string }) => step.id === "configure-publishable-key",
    );
    const environment = output.plan.steps.find(
      (step: { id: string }) => step.id === "inject-clerk-environment",
    );
    const auth = output.plan.steps.find(
      (step: { id: string }) => step.id === "add-authentication-flow",
    );
    expect(configure).toMatchObject({ status: "required", automatable: true });
    expect(environment).toMatchObject({ status: "required", automatable: true });
    expect(auth).toMatchObject({ status: "required", automatable: true });
    expect(configure.description).toContain("directly");
    expect(environment.description).toContain(".environment(Clerk.shared)");
    expect(await treeDigest(root)).toEqual(before);
  });

  test("non-prebuilt dry-run blocks duplicate Clerk package references without writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-cli-sdk-duplicate-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, {
      clerkSDK: "core-only",
      includeKey: false,
    });
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  var body: some Scene {
    WindowGroup {
      Text("Custom Clerk flow")
    }
  }
}
`,
    );
    const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const project = await Bun.file(projectPath).text();
    const packageReferences = `packageReferences = ( ${IOS_FIXTURE_IDS.clerkPackage}, );`;
    expect(project).toContain(packageReferences);
    await Bun.write(
      projectPath,
      project.replace(
        packageReferences,
        `packageReferences = ( ${IOS_FIXTURE_IDS.clerkPackage}, ${IOS_FIXTURE_IDS.clerkPackage}, );`,
      ),
    );
    const configDir = await createIsolatedCLIState();
    const projectBefore = await treeDigest(root);
    const configBefore = await treeDigest(configDir);

    const result = await runCLI(
      root,
      ["--mode", "human", "init", "--dry-run", "--json"],
      isolatedCLIEnvironment(configDir),
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    const sdk = output.plan.steps.find((step: { id: string }) => step.id === "install-clerk-sdk");
    expect(output.status).toBe("blocked");
    expect(output.inspection.appTargets[0]?.packages).toMatchObject({
      clerkKit: "linked",
      clerkKitUI: "absent",
    });
    expect(sdk).toMatchObject({ status: "blocked", automatable: false });
    expect(sdk.description).toContain("duplicate object ID");
    expect(await treeDigest(root)).toEqual(projectBefore);
    expect(await treeDigest(configDir)).toEqual(configBefore);
  });

  test("non-prebuilt dry-run reviews fully linked unattributed products without writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-cli-sdk-unattributed-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, {
      clerkSDK: "core-only",
      includeKey: false,
    });
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  var body: some Scene {
    WindowGroup {
      Text("Custom Clerk flow")
    }
  }
}
`,
    );
    const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const project = await Bun.file(projectPath).text();
    const attributedProduct = `package = ${IOS_FIXTURE_IDS.clerkPackage}; productName = ClerkKit;`;
    const packageReferences = `packageReferences = ( ${IOS_FIXTURE_IDS.clerkPackage}, );`;
    const packageObject = `    ${IOS_FIXTURE_IDS.clerkPackage} = { isa = XCRemoteSwiftPackageReference; repositoryURL = "https://github.com/clerk/clerk-ios.git"; requirement = { kind = upToNextMajorVersion; minimumVersion = 1.0.0; }; };\n`;
    expect(project).toContain(attributedProduct);
    expect(project).toContain(packageReferences);
    expect(project).toContain(packageObject);
    await Bun.write(
      projectPath,
      project
        .replace(attributedProduct, "productName = ClerkKit;")
        .replace(packageReferences, "packageReferences = ( );")
        .replace(packageObject, ""),
    );
    const configDir = await createIsolatedCLIState();
    const projectBefore = await treeDigest(root);
    const configBefore = await treeDigest(configDir);

    const result = await runCLI(
      root,
      ["--mode", "human", "init", "--dry-run", "--json"],
      isolatedCLIEnvironment(configDir),
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    const sdk = output.plan.steps.find((step: { id: string }) => step.id === "install-clerk-sdk");
    expect(output.status).not.toBe("blocked");
    expect(output.inspection.appTargets[0]?.packages).toMatchObject({
      package: "unattributed",
      clerkKit: "linked",
      clerkKitUI: "absent",
    });
    expect(sdk).toMatchObject({ status: "review", automatable: false });
    expect(sdk.description).toContain("could not be verified as clerk-ios");
    expect(await treeDigest(root)).toEqual(projectBefore);
    expect(await treeDigest(configDir)).toEqual(configBefore);
  });

  test("explicit AuthView dry-run blocks a ProcessInfo runtime without root environment injection", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-cli-auth-process-info-"));
    temporaryDirectories.push(root);
    await cp(canonicalSwiftUIFixture, root, { recursive: true });
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() {
    Clerk.configure(
      publishableKey: ProcessInfo.processInfo.environment["CLERK_PUBLISHABLE_KEY"] ?? ""
    )
  }

  var body: some Scene {
    WindowGroup {
      ContentView()
    }
  }
}
`,
    );
    const publishableKey = `pk_test_${Buffer.from("dry-run-process-info.clerk.example$").toString("base64")}`;
    const schemeDirectory = join(root, "MyApp.xcodeproj", "xcshareddata", "xcschemes");
    await mkdir(schemeDirectory, { recursive: true });
    await Bun.write(
      join(schemeDirectory, "MyApp.xcscheme"),
      `<Scheme><LaunchAction><BuildableProductRunnable><BuildableReference BlueprintIdentifier="${IOS_FIXTURE_IDS.appTarget}" /></BuildableProductRunnable><EnvironmentVariables><EnvironmentVariable key="CLERK_PUBLISHABLE_KEY" value="${publishableKey}" isEnabled="YES" /></EnvironmentVariables></LaunchAction></Scheme>`,
    );
    const configDir = await createIsolatedCLIState();
    const before = await treeDigest(root);

    const result = await runCLI(
      root,
      ["--mode", "human", "init", "--dry-run", "--json", "--prebuilt-auth-ui"],
      isolatedCLIEnvironment(configDir),
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    const configure = output.plan.steps.find(
      (step: { id: string }) => step.id === "configure-publishable-key",
    );
    const environment = output.plan.steps.find(
      (step: { id: string }) => step.id === "inject-clerk-environment",
    );
    const auth = output.plan.steps.find(
      (step: { id: string }) => step.id === "add-authentication-flow",
    );
    expect(configure).toMatchObject({ status: "satisfied" });
    expect(environment).toMatchObject({ status: "required", automatable: false });
    expect(auth).toMatchObject({ status: "blocked", automatable: false });
    expect(auth.description).toContain(
      "Clerk.shared is not proven in the shipping SwiftUI root environment",
    );
    expect(result.stdout).not.toContain(publishableKey);
    expect(await treeDigest(root)).toEqual(before);
  });

  test("explicit Apple opt-in previews only the local entitlement during a network-free dry-run", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-cli-apple-dry-run-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { clerkSDK: false, includeKey: false });
    await convertIOSFixtureToSynchronizedMissingEntitlements(root);
    const configDir = await createIsolatedCLIState();
    const before = await treeDigest(root);
    let requestCount = 0;
    const requestTrap = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requestCount += 1;
        return Response.json({ ok: true });
      },
    });

    try {
      const result = await runCLI(
        root,
        ["--mode", "human", "init", "--dry-run", "--json", "--sign-in-with-apple"],
        isolatedCLIEnvironment(configDir, { CLERK_PLATFORM_API_URL: requestTrap.url.origin }),
      );

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      const apple = output.plan.steps.find(
        (step: { id: string }) => step.id === "enable-native-apple",
      );
      expect(apple).toMatchObject({ status: "required", automatable: true });
      expect(apple.description).toContain("native Sign in with Apple entitlement");
      expect(result.stdout).not.toContain("Services ID");
      expect(result.stdout).not.toContain("private key");
      expect(requestCount).toBe(0);
      expect(await treeDigest(root)).toEqual(before);
    } finally {
      await requestTrap.stop(true);
    }
  });

  test("explicit prebuilt AuthView dry-run refuses to overwrite a partial existing flow without network access", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-cli-prebuilt-auth-dry-run-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true, includeKey: false });
    const configDir = await createIsolatedCLIState();
    const before = await treeDigest(root);
    let requestCount = 0;
    const requestTrap = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requestCount += 1;
        return Response.json({ ok: true });
      },
    });

    try {
      const result = await runCLI(
        root,
        ["--mode", "human", "init", "--dry-run", "--json", "--prebuilt-auth-ui"],
        isolatedCLIEnvironment(configDir, { CLERK_PLATFORM_API_URL: requestTrap.url.origin }),
      );

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      const auth = output.plan.steps.find(
        (step: { id: string }) => step.id === "add-authentication-flow",
      );
      expect(auth).toMatchObject({ status: "blocked", automatable: false });
      expect(auth.description).toContain("not safe to rewrite automatically");
      expect(auth.description).toContain("network-free local plan");
      expect(JSON.stringify(output)).not.toContain("connection_oauth_apple");
      expect(requestCount).toBe(0);
      expect(await treeDigest(root)).toEqual(before);
    } finally {
      await requestTrap.stop(true);
    }
  });

  test("explicit prebuilt AuthView dry-run blocks a target below iOS 17 without network access", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-cli-prebuilt-auth-ios16-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { clerkSDK: false, includeKey: false });
    const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
    await Bun.write(
      projectPath,
      (await Bun.file(projectPath).text()).replaceAll(
        "IPHONEOS_DEPLOYMENT_TARGET = 17.0",
        "IPHONEOS_DEPLOYMENT_TARGET = 16.4",
      ),
    );
    const configDir = await createIsolatedCLIState();
    const before = await treeDigest(root);
    let requestCount = 0;
    const requestTrap = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requestCount += 1;
        return Response.json({ ok: true });
      },
    });

    try {
      const result = await runCLI(
        root,
        ["--mode", "human", "init", "--dry-run", "--json", "--prebuilt-auth-ui"],
        isolatedCLIEnvironment(configDir, { CLERK_PLATFORM_API_URL: requestTrap.url.origin }),
      );

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      const auth = output.plan.steps.find(
        (step: { id: string }) => step.id === "add-authentication-flow",
      );
      expect(auth).toMatchObject({ status: "blocked", automatable: false });
      expect(auth.description).toContain("require iOS 17.0 or newer");
      expect(auth.description).toContain("IPHONEOS_DEPLOYMENT_TARGET");
      expect(requestCount).toBe(0);
      expect(await treeDigest(root)).toEqual(before);
    } finally {
      await requestTrap.stop(true);
    }
  });

  test("advertises missing-entitlements creation for a satisfied LocalSecrets integration", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-cli-local-secrets-domain-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, {
      complete: true,
      includeKey: false,
      localSecrets: true,
    });
    await convertIOSFixtureToSynchronizedMissingEntitlements(root);
    const configDir = await createIsolatedCLIState();
    const before = await treeDigest(root);

    const result = await runCLI(
      root,
      ["--mode", "human", "init", "--dry-run", "--json"],
      isolatedCLIEnvironment(configDir),
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.plan.steps).toContainEqual(
      expect.objectContaining({
        id: "configure-publishable-key",
        status: "satisfied",
      }),
    );
    expect(output.plan.steps).toContainEqual(
      expect.objectContaining({
        id: "add-associated-domain",
        status: "required",
        automatable: true,
      }),
    );
    expect(output.nativeReadiness.associatedDomain).toMatchObject({
      status: "required",
      automatable: true,
      files: ["MyApp/MyApp.entitlements"],
      blockers: [],
    });
    expect(result.stdout).not.toContain("pk_live_");
    expect(await treeDigest(root)).toEqual(before);
  });

  test("does not advertise runtime-key automation when the strict plist preflight blocks", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-cli-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true, includeKey: false, localSecrets: true });
    await Bun.write(join(root, "MyApp", "LocalSecrets.plist"), "<plist><dict>");
    const configDir = await createIsolatedCLIState();
    const before = await treeDigest(root);

    const result = await runCLI(
      root,
      ["--mode", "human", "init", "--dry-run", "--json"],
      isolatedCLIEnvironment(configDir),
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    const configure = output.plan.steps.find(
      (step: { id: string }) => step.id === "configure-publishable-key",
    );
    expect(configure).toMatchObject({ status: "blocked", automatable: false });
    expect(configure.description).toContain("readable XML property-list dictionary");
    expect(configure.description).not.toContain("clerk init can fetch");
    expect(await treeDigest(root)).toEqual(before);
  });

  test("rejects remote-state flags before authentication or linking", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-cli-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root);
    const configDir = await createIsolatedCLIState();
    const projectBefore = await treeDigest(root);
    const configBefore = await treeDigest(configDir);

    const result = await runCLI(
      root,
      ["init", "--dry-run", "--app", "app_never_contact"],
      isolatedCLIEnvironment(configDir),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--dry-run cannot be combined");
    expect(await treeDigest(root)).toEqual(projectBefore);
    expect(await treeDigest(configDir)).toEqual(configBefore);
  });

  test("human output labels an ambiguous target as incomplete without implying failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-cli-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { secondTarget: true });
    const configDir = await createIsolatedCLIState();
    const projectBefore = await treeDigest(root);
    const configBefore = await treeDigest(configDir);

    const result = await runCLI(
      root,
      ["--mode", "human", "init", "--dry-run"],
      isolatedCLIEnvironment(configDir),
    );

    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Setup incomplete");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("Plan blocked");
    expect(await treeDigest(root)).toEqual(projectBefore);
    expect(await treeDigest(configDir)).toEqual(configBefore);
  });

  test("human output distinguishes an actionable plan from a ready plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-cli-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root);
    const configDir = await createIsolatedCLIState();
    const projectBefore = await treeDigest(root);
    const configBefore = await treeDigest(configDir);

    const result = await runCLI(
      root,
      ["--mode", "human", "init", "--dry-run"],
      isolatedCLIEnvironment(configDir),
    );

    expect(result.exitCode).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("Setup incomplete");
    expect(output).not.toContain("Setup looks ready");
    expect(output).toContain("not inspected during this local-only dry-run");
    expect(output).toContain("Regular");
    expect(output).toContain("audits and safely reconciles both");
    expect(output).not.toContain("does not expose these resources");
    expect(await treeDigest(root)).toEqual(projectBefore);
    expect(await treeDigest(configDir)).toEqual(configBefore);
  });
});
