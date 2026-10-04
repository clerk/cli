import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIOSFixture, treeDigest } from "./test-helpers.ts";
import type { IOSApplication } from "../../../lib/plapi.ts";
import { applySetup, describePreview, prepareSetup, type SetupOptions } from "./workflow.ts";
import { doctor } from "./doctor.ts";
import { PlapiError } from "../../../lib/errors.ts";
import { type NativeAPI, type RemoteInput } from "./remote.ts";
import { runCommand, XcodeCommandError, type CommandRunner } from "./xcode.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const identity: RemoteInput = {
  applicationId: "app_test",
  instanceId: "ins_test",
  bundleIdentifier: "com.example.FinalIdentity",
  appIdPrefix: "FINAL12345",
};
const key = `pk_test_${btoa("fixture.clerk.accounts.dev$")}`;

function server() {
  const state = {
    enabled: false,
    applications: [] as IOSApplication[],
    events: [] as string[],
    keys: [] as string[],
    failCreate: false,
    createError: undefined as unknown,
    failListAfterCreate: false,
    listFails: false,
    failAfterCreate: false,
    failEnable: false,
    wrongCreated: false,
    production: false,
    wrongApp: false,
    changedKey: false,
  };
  const api: NativeAPI = {
    async fetchApplication(id, options) {
      expect(options).toEqual({ includeSecretKeys: false });
      return {
        application_id: state.wrongApp ? "app_wrong" : id,
        instances: [
          {
            instance_id: "ins_test",
            environment_type: state.production ? "production" : "development",
            publishable_key: state.changedKey
              ? `pk_test_${btoa("changed.clerk.accounts.dev$")}`
              : key,
          },
        ],
      };
    },
    async getNativeSettings() {
      return { object: "native_settings", api_enabled: state.enabled };
    },
    async listIOSApplications() {
      if (state.listFails) throw new Error("Registrations unavailable");
      return [...state.applications];
    },
    async createIOSApplication(_app, _instance, params, idempotencyKey) {
      state.events.push("register");
      state.keys.push(idempotencyKey);
      if (state.failCreate) throw new Error("Ambiguous connection failure");
      if (state.createError) {
        state.listFails = state.failListAfterCreate;
        throw state.createError;
      }
      const created: IOSApplication = {
        object: "ios_application",
        id: "ios_test",
        app_id_prefix: params.app_id_prefix,
        bundle_id: state.wrongCreated ? "com.wrong.App" : params.bundle_id,
      };
      state.applications.push(created);
      if (state.failAfterCreate) throw new TypeError("fetch failed");
      return created;
    },
    async enableNativeApi() {
      state.events.push("enable");
      if (state.failEnable) throw new Error("Server unavailable");
      state.enabled = true;
      return { object: "native_settings", api_enabled: true };
    },
  };
  return { api, state };
}

async function fixture(platform: "ios" | "macos" = "ios") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clerk-apple-workflow-")));
  roots.push(root);
  await createIOSFixture(root, {
    platform,
    clerkSDK: false,
    includeKey: false,
    secondTarget: true,
    xcconfig: true,
  });
  const options: SetupOptions = {
    root,
    target: "MyApp",
    products: "ui",
    minimumVersion: "1.0.0",
    resolvePackages: false,
    remote: identity,
  };
  const path = join(root, "MyApp.xcodeproj/project.pbxproj");
  const remote = server();
  // Explicitly synthetic process output. The separate probe exercises actual Xcode.
  const run: CommandRunner = async (command) =>
    JSON.stringify([
      {
        target: "MyApp",
        buildSettings: {
          TARGET_NAME: "MyApp",
          CONFIGURATION: command[command.indexOf("-configuration") + 1],
          PLATFORM_NAME: platform === "ios" ? "iphoneos" : "macosx",
          PROJECT_FILE_PATH: join(root, "MyApp.xcodeproj"),
          PRODUCT_TYPE: "com.apple.product-type.application",
          PRODUCT_BUNDLE_IDENTIFIER: "com.example.NotFinalIdentity",
          DEVELOPMENT_TEAM: "TEAMID1234",
          IPHONEOS_DEPLOYMENT_TARGET: "17.0",
          MACOSX_DEPLOYMENT_TARGET: "14.0",
          ENABLE_APP_SANDBOX: "YES",
        },
      },
    ]);
  return {
    root,
    path,
    options,
    ...remote,
    dependencies: {
      api: remote.api,
      run,
      appleAPI: {
        async fetchInstanceConfig() {
          return {
            connection_oauth_apple: { enabled: false, authenticatable: true },
            config_version: "v1_1234abcd",
          };
        },
        async fetchInstanceConfigSchema() {
          return { properties: {} };
        },
        async patchInstanceConfig() {
          throw new Error("Doctor must not write");
        },
      },
    },
  };
}

for (const platform of ["ios", "macos"] as const) {
  test(`${platform}: full preview, single-file apply, remote registration, rerun, and Doctor`, async () => {
    const f = await fixture(platform);
    const source = await readFile(f.path, "utf8");
    await chmod(f.path, 0o640);
    const before = await treeDigest(f.root);
    const preview = await prepareSetup(f.options, f.dependencies);
    expect(await treeDigest(f.root)).toEqual(before);
    expect(f.state.events).toEqual([]);
    expect(JSON.stringify(describePreview(preview))).not.toContain(key);
    expect(JSON.stringify(describePreview(preview))).not.toContain("TEAMID1234");
    const result = await applySetup(preview, f.dependencies);
    expect(result).toMatchObject({ local: "updated", remote: "verified" });
    expect(await readFile(join(f.root, result.backups.at(-1)!), "utf8")).toBe(source);
    expect((await stat(f.path)).mode & 0o777).toBe(0o640);
    expect(f.state.events).toEqual(["register", "enable"]);
    expect(f.state.applications[0]).toMatchObject({
      bundle_id: identity.bundleIdentifier,
      app_id_prefix: identity.appIdPrefix,
    });
    expect(result.handoff.publishableKey).toBe(key);
    expect(result.instructions.join("\n")).not.toContain("ClerkProvider");
    const after = await treeDigest(f.root);
    const rerun = await prepareSetup(f.options, f.dependencies);
    expect((await applySetup(rerun, f.dependencies)).local).toBe("unchanged");
    expect(await treeDigest(f.root)).toEqual(after);
    const report = await doctor(f.options, f.dependencies);
    expect(report.checks.find((check) => check.name === "SDK project linkage")?.status).toBe(
      "pass",
    );
    expect(report.appIntegrationComplete).toBe(false);
    expect(f.state.events).toEqual(["register", "enable"]);
    expect(await treeDigest(f.root)).toEqual(after);
    expect(JSON.stringify(report)).not.toContain(key);
    const changedOriginals = before.filter(
      (entry) =>
        entry.startsWith("f:") && !entry.includes("project.pbxproj") && !after.includes(entry),
    );
    expect(changedOriginals).toEqual([]);
  });
}

test("ambiguous project or target requires explicit selection, including macOS inference", async () => {
  const f = await fixture("macos");
  await expect(prepareSetup({ ...f.options, target: undefined }, f.dependencies)).rejects.toThrow(
    "--xcode-target",
  );
  await mkdir(join(f.root, "Other.xcodeproj"));
  await expect(prepareSetup(f.options, f.dependencies)).rejects.toThrow("--xcode-project");
  const preview = await prepareSetup(
    { ...f.options, project: join(f.root, "MyApp.xcodeproj") },
    f.dependencies,
  );
  expect(preview.inspection.input.selection.sdk).toBe("macosx");
});

test("stale bytes, replacement inode, and symlink edits never reach the remote writer", async () => {
  for (const mutation of ["bytes", "inode", "symlink"]) {
    const f = await fixture();
    const preview = await prepareSetup(f.options, f.dependencies);
    if (mutation === "bytes") await writeFile(f.path, "user edits");
    else {
      // Keep the original inode allocated so Linux cannot reuse it for the replacement.
      await rename(f.path, `${f.path}.saved`);
      if (mutation === "inode") {
        await copyFile(`${f.path}.saved`, f.path);
        expect((await stat(f.path)).ino).not.toBe(preview.inspection.document.inode);
      } else await symlink(`${f.path}.saved`, f.path);
    }
    await expect(applySetup(preview, f.dependencies)).rejects.toThrow();
    expect(f.state.events).toEqual([]);
    expect(
      (await readdir(join(f.root, "MyApp.xcodeproj"))).some((path) =>
        path.includes("clerk-backup"),
      ),
    ).toBe(false);
  }
});

test("dirty project changes are visible in the preview and backed up without an extra question", async () => {
  const f = await fixture();
  const git = Bun.spawn(["git", "init", "--quiet", f.root], { stdout: "ignore", stderr: "ignore" });
  expect(await git.exited).toBe(0);
  const preview = await prepareSetup(f.options, f.dependencies);
  expect(describePreview(preview).existingGitChanges).toContain("MyApp.xcodeproj/project.pbxproj");
  expect((await applySetup(preview, f.dependencies)).backups).not.toHaveLength(0);
});

test("clean committed files leave no backups behind, since Git can restore them", async () => {
  const f = await fixture();
  for (const command of [
    ["git", "init", "--quiet"],
    ["git", "add", "-A"],
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init"],
  ]) {
    const git = Bun.spawn(command, { cwd: f.root, stdout: "ignore", stderr: "ignore" });
    expect(await git.exited).toBe(0);
  }
  const result = await applySetup(await prepareSetup(f.options, f.dependencies), f.dependencies);
  expect(result.local).toBe("updated");
  expect(result.backups).toEqual([]);
  expect(
    (await readdir(join(f.root, "MyApp.xcodeproj"))).some((path) => path.includes("clerk-backup")),
  ).toBe(false);
});

test("an ignored file keeps its backup, since Git can't restore it", async () => {
  const f = await fixture();
  await writeFile(join(f.root, ".gitignore"), "MyApp.xcodeproj/project.pbxproj\n");
  for (const command of [
    ["git", "init", "--quiet"],
    ["git", "add", "-A"],
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init"],
  ]) {
    const git = Bun.spawn(command, { cwd: f.root, stdout: "ignore", stderr: "ignore" });
    expect(await git.exited).toBe(0);
  }
  const result = await applySetup(await prepareSetup(f.options, f.dependencies), f.dependencies);
  expect(result.local).toBe("updated");
  expect(result.backups).toEqual([expect.stringContaining("project.pbxproj.clerk-backup-")]);
});

test("generator-managed projects receive instructions and no project write", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "project.yml"), "name: MyApp\n");
  const preview = await prepareSetup(f.options, f.dependencies);
  const result = await applySetup(preview, f.dependencies);
  expect(result.local).toBe("unchanged");
  expect(result.remote).toBe("verified");
  expect(result.instructions.join("\n")).toContain("xcodegen specification");
});

test("production, wrong application, missing identity, and conflicting registrations block before local writes", async () => {
  for (const failure of ["production", "wrongApp", "missingPrefix", "conflict", "duplicate"]) {
    const f = await fixture();
    if (failure === "production") f.state.production = true;
    if (failure === "wrongApp") f.state.wrongApp = true;
    if (failure === "missingPrefix") {
      f.options.remote = { ...identity, appIdPrefix: "" };
      const original = f.dependencies.run;
      f.dependencies.run = async (command, root, signal) =>
        (await original(command, root, signal)).replace("TEAMID1234", "");
    }
    if (failure === "conflict" || failure === "duplicate") {
      const app: IOSApplication = {
        object: "ios_application",
        id: "existing",
        bundle_id: identity.bundleIdentifier,
        app_id_prefix: failure === "conflict" ? "WRONG12345" : identity.appIdPrefix,
      };
      f.state.applications = failure === "duplicate" ? [app, app] : [app];
    }
    const before = await treeDigest(f.root);
    await expect(prepareSetup(f.options, f.dependencies)).rejects.toThrow();
    expect(await treeDigest(f.root)).toEqual(before);
    expect(f.state.events).toEqual([]);
  }
});

test("changed remote key or newly required action needs a new preview", async () => {
  const f = await fixture();
  f.state.enabled = true;
  const preview = await prepareSetup(f.options, f.dependencies);
  f.state.enabled = false;
  await expect(applySetup(preview, f.dependencies)).rejects.toThrow("additional action");
  f.state.enabled = true;
  f.state.changedKey = true;
  await expect(applySetup(preview, f.dependencies)).rejects.toThrow("key changed");
  expect(f.state.events).toEqual([]);
});

test("ambiguous registration failure preserves SDK work and stable retry identity across fresh plans", async () => {
  const f = await fixture();
  f.state.failCreate = true;
  const first = await applySetup(await prepareSetup(f.options, f.dependencies), f.dependencies);
  expect(first).toMatchObject({ local: "updated", remote: "incomplete" });
  f.state.failCreate = false;
  const second = await applySetup(await prepareSetup(f.options, f.dependencies), f.dependencies);
  expect(second).toMatchObject({ local: "unchanged", remote: "verified" });
  expect(f.state.keys).toHaveLength(2);
  expect(f.state.keys[0]).toBe(f.state.keys[1]);
  expect(f.state.events).toEqual(["register", "register", "enable"]);
});

test("a create rejection is reported even when the reconcile read also fails", async () => {
  const f = await fixture();
  f.state.createError = PlapiError.fromBody(422, '{"errors":[{"message":"bundle_id is invalid"}]}');
  f.state.failListAfterCreate = true;
  const result = await applySetup(await prepareSetup(f.options, f.dependencies), f.dependencies);
  expect(result.remote).toBe("incomplete");
  expect(result.message).toContain("bundle_id is invalid");
  expect(result.message).not.toContain("Registrations unavailable");
});

test("enable failure reconciles without duplicate registrations", async () => {
  const f = await fixture();
  f.state.failEnable = true;
  const first = await applySetup(await prepareSetup(f.options, f.dependencies), f.dependencies);
  expect(first.remote).toBe("incomplete");
  expect(f.state.applications).toHaveLength(1);
  f.state.failEnable = false;
  expect(
    (await applySetup(await prepareSetup(f.options, f.dependencies), f.dependencies)).remote,
  ).toBe("verified");
  expect(f.state.events).toEqual(["register", "enable", "enable"]);
});

test("a lost successful create response reconciles by reading the registration", async () => {
  const f = await fixture();
  f.state.failAfterCreate = true;
  expect(
    (await applySetup(await prepareSetup(f.options, f.dependencies), f.dependencies)).remote,
  ).toBe("verified");
  expect(f.state.applications).toHaveLength(1);
  expect(f.state.events).toEqual(["register", "enable"]);
});

test("a wrong create response cannot enable Native API", async () => {
  const f = await fixture();
  f.state.wrongCreated = true;
  const result = await applySetup(await prepareSetup(f.options, f.dependencies), f.dependencies);
  expect(result.remote).toBe("incomplete");
  expect(f.state.enabled).toBe(false);
  expect(f.state.events).toEqual(["register"]);
});

test("cancelled setup, invalid Xcode output, and failed processes are bounded and explain themselves", async () => {
  const f = await fixture();
  const preview = await prepareSetup(f.options, f.dependencies);
  await expect(applySetup(preview, f.dependencies, AbortSignal.abort())).rejects.toThrow();
  expect(f.state.events).toEqual([]);
  await expect(
    prepareSetup(f.options, { ...f.dependencies, run: async () => "[]" }),
  ).rejects.toThrow();
  await expect(
    runCommand(
      [
        process.execPath,
        "-e",
        "console.error('You have not agreed to the Xcode license.');process.exit(1)",
      ],
      f.root,
    ),
  ).rejects.toThrow(/exited with code 1[\s\S]*You have not agreed to the Xcode license/);
  await expect(
    runCommand([process.execPath, "-e", "console.log('x'.repeat(8_000_001))"], f.root),
  ).rejects.toThrow("Xcode returned more output");
  await expect(
    runCommand(
      [process.execPath, "-e", "setInterval(()=>{},1000)"],
      f.root,
      AbortSignal.timeout(50),
    ),
  ).rejects.toThrow();
});

async function discoveredFixture() {
  const f = await fixture();
  const original = f.dependencies.run;
  f.dependencies.run = async (command, root, signal) => {
    const rows = JSON.parse(await original(command, root, signal));
    Object.assign(rows[0].buildSettings, {
      GENERATE_INFOPLIST_FILE: "YES",
      PRODUCT_BUNDLE_IDENTIFIER: identity.bundleIdentifier,
    });
    return JSON.stringify(rows);
  };
  return f;
}

test("ordinary Bundle ID and existing Clerk prefix are discovered without questions", async () => {
  const f = await discoveredFixture();
  await applySetup(await prepareSetup(f.options, f.dependencies), f.dependencies);
  const options = { ...f.options, remote: { applicationId: identity.applicationId } };
  const preview = await prepareSetup(options, {
    ...f.dependencies,
    promptIdentity: async () => {
      throw new Error("Unnecessary question");
    },
  });
  expect(describePreview(preview).identity).toMatchObject({
    bundleIdentifier: identity.bundleIdentifier,
    appIdPrefix: identity.appIdPrefix,
    bundleSource: "xcode",
    prefixSource: "clerk-registration",
  });
  expect(preview.remote?.actions).toEqual([]);
});

test("invalid registered prefixes produce actionable identity diagnostics without writes", async () => {
  const f = await discoveredFixture();
  await applySetup(await prepareSetup(f.options, f.dependencies), f.dependencies);
  f.state.applications[0]!.app_id_prefix = "invalid-prefix";
  f.state.events.length = 0;
  const options = { ...f.options, remote: { applicationId: identity.applicationId } };
  await expect(prepareSetup(options, f.dependencies)).rejects.toMatchObject({
    discovery: {
      context: undefined,
      prefixSource: "clerk-registration",
      issues: [expect.stringContaining("Correct its ten-character prefix in the Clerk Dashboard")],
    },
  });
  const report = await doctor(options, f.dependencies);
  expect(report.identity?.issues).toEqual([expect.stringContaining("invalid Apple App ID Prefix")]);
  expect(report.identity?.nativeApiEnabled).toBe(true);
  expect(f.state.events).toEqual([]);
  await expect(
    prepareSetup(
      { ...options, remote: { ...options.remote, appIdPrefix: "invalid-prefix" } },
      f.dependencies,
    ),
  ).rejects.toThrow("Supply a valid ten-character Apple App ID Prefix");
});

test("Doctor reads Native API and registrations without requiring or prompting for a prefix", async () => {
  const f = await discoveredFixture();
  const report = await doctor(
    { ...f.options, remote: { applicationId: identity.applicationId } },
    {
      ...f.dependencies,
      promptIdentity: async () => {
        throw new Error("Doctor must not prompt");
      },
    },
  );
  expect(report.identity).toMatchObject({
    nativeApiEnabled: false,
    registrations: [],
    bundleIdentifier: identity.bundleIdentifier,
    appIdPrefix: "TEAMID1234",
    prefixSource: "signing-team",
  });
  expect(report.checks.find((check) => check.name === "Native API")?.status).toBe("warn");
  expect(JSON.stringify(report)).not.toContain(key);
  expect(f.state.events).toEqual([]);
  const questions: (string | undefined)[][] = [];
  const preview = await prepareSetup(
    { ...f.options, remote: { applicationId: identity.applicationId } },
    {
      ...f.dependencies,
      promptIdentity: async (field, _message, suggestion) => {
        questions.push([field, suggestion]);
        return identity.appIdPrefix;
      },
    },
  );
  expect(questions).toEqual([["appIdPrefix", "TEAMID1234"]]);
  expect(preview.remote?.context).toMatchObject({
    bundleIdentifier: identity.bundleIdentifier,
    appIdPrefix: identity.appIdPrefix,
  });
});

test("without a prompt, one signing team supplies the App ID Prefix; differing teams don't", async () => {
  const f = await discoveredFixture();
  const options = { ...f.options, remote: { applicationId: identity.applicationId } };
  expect(describePreview(await prepareSetup(options, f.dependencies)).identity).toMatchObject({
    appIdPrefix: "TEAMID1234",
    prefixSource: "signing-team",
  });

  const original = f.dependencies.run;
  f.dependencies.run = async (command, root, signal) => {
    const output = await original(command, root, signal);
    return command.includes("Release") ? output.replace("TEAMID1234", "OTHERTEAM1") : output;
  };
  await expect(prepareSetup(options, f.dependencies)).rejects.toThrow();
});

test("setup resolves preexisting dependencies only after inspection fails, then resolves the added SDK", async () => {
  const f = await discoveredFixture();
  const events: string[] = [];
  let failed = false;
  const run: CommandRunner = async (command, root, signal) => {
    if (command.includes("-resolvePackageDependencies")) {
      events.push("resolve");
      return "Resolved packages";
    }
    events.push("inspect");
    if (!failed) {
      failed = true;
      throw new XcodeCommandError(
        "xcodebuild exited with code 74.",
        "xcodebuild: error: Could not resolve package dependencies: Missing package product 'ClerkKit'",
      );
    }
    return f.dependencies.run(command, root, signal);
  };
  const progress: string[] = [];
  const preview = await prepareSetup(
    { ...f.options, resolvePackages: true, progress: (message) => progress.push(message) },
    { ...f.dependencies, run },
  );
  expect(events).toEqual(["inspect", "resolve", "inspect", "inspect"]);
  const result = await applySetup(preview, { ...f.dependencies, run });
  expect(result.packages).toBe("resolved");
  expect(events.at(-1)).toBe("resolve");
  expect(progress.some((message) => message.includes("Swift packages resolved"))).toBe(true);
  expect(result.handoff.completed.some((step) => step.id === "swift-packages")).toBe(true);
});

test("inspection failures unrelated to packages do not trigger package resolution", async () => {
  const f = await fixture();
  const events: string[] = [];
  const run: CommandRunner = async (command) => {
    events.push(command.includes("-resolvePackageDependencies") ? "resolve" : "inspect");
    throw new XcodeCommandError(
      "xcodebuild exited with code 69.",
      "You have not agreed to the Xcode license agreements.",
    );
  };
  await expect(
    prepareSetup({ ...f.options, resolvePackages: true }, { ...f.dependencies, run }),
  ).rejects.toThrow("Xcode license");
  expect(events).toEqual(["inspect"]);
});

test("package failure keeps SDK edits, still registers the app, and redacts credentials", async () => {
  const f = await fixture();
  const preview = await prepareSetup({ ...f.options, resolvePackages: true }, f.dependencies);
  const result = await applySetup(preview, {
    ...f.dependencies,
    run: async () => {
      throw new XcodeCommandError(
        "xcodebuild exited with code 74.",
        "Failed to clone https://octo:ghp_secret@github.com/acme/private.git",
      );
    },
  });
  expect(result).toMatchObject({ local: "updated", packages: "incomplete", remote: "verified" });
  expect(result.handoff.remaining.some((step) => step.id === "swift-packages")).toBe(true);
  expect(f.state.events).toEqual(["register", "enable"]);
  expect(result.message).toContain("https://***@github.com/acme/private.git");
  expect(result.message).not.toContain("ghp_secret");
});

test("a Bundle ID changed after the preview is not registered", async () => {
  const f = await discoveredFixture();
  const preview = await prepareSetup(
    {
      ...f.options,
      remote: { applicationId: identity.applicationId, appIdPrefix: identity.appIdPrefix },
    },
    f.dependencies,
  );
  // As if an xcconfig changed PRODUCT_BUNDLE_IDENTIFIER while the user reviewed the preview.
  const original = f.dependencies.run;
  const run: CommandRunner = async (command, root, signal) => {
    const rows = JSON.parse(await original(command, root, signal));
    rows[0].buildSettings.PRODUCT_BUNDLE_IDENTIFIER = "com.example.Changed";
    return JSON.stringify(rows);
  };
  const result = await applySetup(preview, { ...f.dependencies, run });
  expect(result.remote).toBe("incomplete");
  expect(result.message).toContain("Bundle ID changed after the preview");
  expect(f.state.events).toEqual([]);
});

test("inspection-only planning never retries through a package download", async () => {
  const f = await fixture();
  const calls: string[][] = [];
  await expect(
    prepareSetup(
      { ...f.options, resolvePackages: true, inspectOnly: true },
      {
        ...f.dependencies,
        run: async (command) => {
          calls.push(command);
          throw new Error("Missing checkout");
        },
      },
    ),
  ).rejects.toThrow("Missing checkout");
  expect(calls.some((command) => command.includes("-resolvePackageDependencies"))).toBe(false);
});
