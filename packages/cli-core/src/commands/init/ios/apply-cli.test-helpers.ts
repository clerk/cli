import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build as buildPbxProject, parse as parsePbxProject } from "@bacons/xcode/json";
import { createIOSFixture, IOS_FIXTURE_IDS } from "./test-helpers.ts";
import type { PbxObjects } from "./pbx.ts";

export const temporaryDirectories: string[] = [];
const cliPath = resolve(import.meta.dir, "../../../cli.ts");
export const canonicalSwiftUIFixture = resolve(
  import.meta.dir,
  "../../../../../../test/e2e/fixtures/ios",
);
export const authFixtureKey = `pk_test_${Buffer.from("ios-apply.clerk.example$").toString("base64")}`;
const authFixtureApp = {
  application_id: "app_ios_apply",
  name: "iOS Apply Fixture",
  instances: [
    {
      instance_id: "ins_ios_apply_development",
      environment_type: "development",
      publishable_key: authFixtureKey,
    },
  ],
};
let nativeAPIEnabled = false;
let nextIOSApplication = 1;
let nativeSettingsPatchCount = 0;
let iosApplicationPostCount = 0;
let appleConfigPatchCount = 0;
let appleConfigVersion = "v1_1234abcd";
let appleConnection: Record<string, unknown> = {
  enabled: false,
  authenticatable: true,
};
const iosApplications: Array<{
  object: "ios_application";
  id: string;
  app_id_prefix: string;
  bundle_id: string;
  created_at: number;
  updated_at: number;
}> = [];
const authServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/platform/applications") {
      return Response.json([]);
    }
    if (request.method === "POST" && url.pathname === "/v1/platform/applications") {
      return Response.json(authFixtureApp);
    }
    if (
      request.method === "GET" &&
      url.pathname === `/v1/platform/applications/${authFixtureApp.application_id}`
    ) {
      return Response.json(authFixtureApp);
    }
    const nativeBase = `/v1/platform/applications/${authFixtureApp.application_id}/instances/ins_ios_apply_development`;
    if (url.pathname === `${nativeBase}/native_settings`) {
      if (request.method === "GET") {
        return Response.json({ object: "native_settings", api_enabled: nativeAPIEnabled });
      }
      if (request.method === "PATCH") {
        nativeSettingsPatchCount += 1;
        const body = (await request.json()) as { api_enabled?: boolean };
        if (body.api_enabled !== true) return Response.json({ error: "invalid" }, { status: 422 });
        nativeAPIEnabled = true;
        return Response.json({ object: "native_settings", api_enabled: true });
      }
    }
    if (url.pathname === `${nativeBase}/native_applications/ios`) {
      if (request.method === "GET") return Response.json(iosApplications);
      if (request.method === "POST") {
        iosApplicationPostCount += 1;
        const body = (await request.json()) as { app_id_prefix: string; bundle_id: string };
        const existing = iosApplications.find(
          (application) =>
            application.app_id_prefix === body.app_id_prefix &&
            application.bundle_id === body.bundle_id,
        );
        if (existing) return Response.json(existing, { status: 201 });
        const now = Date.now();
        const application = {
          object: "ios_application" as const,
          id: `iosapp_${nextIOSApplication++}`,
          app_id_prefix: body.app_id_prefix,
          bundle_id: body.bundle_id,
          created_at: now,
          updated_at: now,
        };
        iosApplications.push(application);
        return Response.json(application, { status: 201 });
      }
    }
    if (url.pathname === `${nativeBase}/config/schema` && request.method === "GET") {
      return Response.json({
        type: "object",
        properties: {
          connection_oauth_apple: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              authenticatable: { type: "boolean" },
              bundle_id: { type: "string" },
              client_id: { type: "string" },
              client_secret: { type: "string", "x-clerk-sensitive": true },
              team_id: { type: "string" },
              key_id: { type: "string" },
            },
          },
        },
      });
    }
    if (url.pathname === `${nativeBase}/config`) {
      if (request.method === "GET") {
        return Response.json({
          config_version: appleConfigVersion,
          connection_oauth_apple: appleConnection,
        });
      }
      if (request.method === "PATCH") {
        appleConfigPatchCount += 1;
        const body = (await request.json()) as {
          connection_oauth_apple?: Record<string, unknown>;
        };
        const update = body.connection_oauth_apple;
        if (!update) return Response.json({ error: "invalid" }, { status: 422 });
        const before = { ...appleConnection };
        const after = { ...appleConnection, ...update };
        const dryRun = url.searchParams.get("dry_run") === "true";
        if (!dryRun) {
          appleConnection = after;
          appleConfigVersion = "v1_9876fedc";
        }
        return Response.json({
          config_version: dryRun ? appleConfigVersion : "v1_9876fedc",
          dry_run: dryRun,
          before: { connection_oauth_apple: before },
          after: { connection_oauth_apple: after },
        });
      }
    }
    return new Response("Not found", { status: 404 });
  },
});

// This helper is shared by multiple test files in the same Bun test worker. Keep
// the fixture server available for the worker's lifetime without keeping the
// process alive; a file-scoped afterAll hook can otherwise stop it while another
// importing test file is still running.
authServer.unref();

export function resetApplyCLITestRemoteState(): void {
  nativeAPIEnabled = false;
  nextIOSApplication = 1;
  nativeSettingsPatchCount = 0;
  iosApplicationPostCount = 0;
  appleConfigPatchCount = 0;
  iosApplications.splice(0);
  resetAppleConfiguration({ enabled: false, authenticatable: true });
}

export async function cleanupApplyCLITestState(): Promise<void> {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
  resetApplyCLITestRemoteState();
}

export async function createIsolatedCLIState(): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), "clerk-ios-apply-config-"));
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

function isolatedEnvironment(configDir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...Bun.env };
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
    CLERK_PLATFORM_API_KEY: "ak_test_ios_apply_fixture",
    CLERK_PLATFORM_API_URL: authServer.url.origin,
    CLERK_TELEMETRY_DISABLED: "1",
  };
}

export async function runCLI(root: string, args: string[], configDir: string) {
  const child = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd: root,
    env: isolatedEnvironment(configDir),
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

export async function runCommand(root: string, command: string[]): Promise<void> {
  const child = Bun.spawn(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode})\n${stdout}\n${stderr}`);
  }
}

export async function createUnconfiguredFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clerk-ios-apply-"));
  temporaryDirectories.push(root);
  await createIOSFixture(root, { clerkSDK: false, includeKey: false });
  return root;
}

export async function createCustomFlowWithStarterContent(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clerk-ios-custom-flow-auth-view-"));
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
  return root;
}

export async function addStarterContentViewToFixture(root: string): Promise<void> {
  const contentFileId = "616161616161616161616161";
  const contentBuildFileId = "626262626262626262626262";
  const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
  const project = parsePbxProject(await Bun.file(projectPath).text());
  const objects = (project as unknown as { objects: PbxObjects }).objects;
  (objects[IOS_FIXTURE_IDS.appGroup]!.children as string[]).push(contentFileId);
  (objects[IOS_FIXTURE_IDS.sourcesPhase]!.files as string[]).push(contentBuildFileId);
  objects[contentFileId] = {
    isa: "PBXFileReference",
    lastKnownFileType: "sourcecode.swift",
    path: "ContentView.swift",
    sourceTree: "<group>",
  };
  objects[contentBuildFileId] = { isa: "PBXBuildFile", fileRef: contentFileId };
  await Bun.write(projectPath, buildPbxProject(project));
  await cp(
    join(canonicalSwiftUIFixture, "MyApp", "ContentView.swift"),
    join(root, "MyApp", "ContentView.swift"),
  );
}

export function developmentPublishableKey(host: string): string {
  return `pk_test_${Buffer.from(`${host}$`).toString("base64")}`;
}

export function resetAppleConfiguration(connection: Record<string, unknown>): void {
  appleConfigVersion = "v1_1234abcd";
  appleConnection = connection;
}

export function currentAppleConnection(): Record<string, unknown> {
  return appleConnection;
}

export function currentNativeRemoteState() {
  return {
    application: structuredClone(authFixtureApp),
    nativeAPIEnabled,
    iosApplications: structuredClone(iosApplications),
    mutations: {
      nativeSettingsPatchCount,
      iosApplicationPostCount,
      appleConfigPatchCount,
    },
  };
}
