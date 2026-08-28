import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as runtimeKey from "./runtime-key.ts";
import { createIOSFixture, IOS_FIXTURE_IDS, treeDigest } from "./test-helpers.ts";

const temporaryDirectories: string[] = [];

function publishableKey(host: string, live = false): string {
  return `pk_${live ? "live" : "test"}_${Buffer.from(`${host}$`).toString("base64")}`;
}

function plistSource(key: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CLERK_PUBLISHABLE_KEY</key>
  <string>${key}</string>
</dict>
</plist>
`;
}

async function fixture(key: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clerk-ios-runtime-key-verification-"));
  temporaryDirectories.push(root);
  await createIOSFixture(root, {
    complete: true,
    includeKey: false,
    localSecrets: true,
  });
  await Bun.write(join(root, "MyApp", "LocalSecrets.plist"), plistSource(key));
  return root;
}

function options(root: string) {
  return {
    root,
    projectPath: "MyApp.xcodeproj",
    targetId: IOS_FIXTURE_IDS.appTarget,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("iOS LocalSecrets compatibility verification", () => {
  test("exposes read-only verification without a LocalSecrets mutation API", () => {
    expect(Object.keys(runtimeKey).sort()).toEqual([
      "planIOSRuntimeKeyVerification",
      "verifyIOSRuntimeKey",
    ]);
    expect("planIOSRuntimeKey" in runtimeKey).toBe(false);
    expect("applyIOSRuntimeKey" in runtimeKey).toBe(false);
  });

  test("compares the exact Quickstart runtime key without retaining or changing it", async () => {
    const localKey = publishableKey("local.clerk.example");
    const linkedKey = publishableKey("linked.clerk.example");
    const root = await fixture(localKey);
    const before = await treeDigest(root);

    const plan = await runtimeKey.planIOSRuntimeKeyVerification(options(root));
    const matched = await runtimeKey.verifyIOSRuntimeKey(plan, localKey);
    const mismatched = await runtimeKey.verifyIOSRuntimeKey(plan, linkedKey);

    expect(plan.status).toBe("ready");
    expect(plan.localSecretsPath).toBe("MyApp/LocalSecrets.plist");
    expect(matched.status).toBe("matched");
    expect(mismatched.status).toBe("mismatched");
    expect(JSON.stringify({ plan, matched, mismatched })).not.toContain(localKey);
    expect(JSON.stringify({ plan, matched, mismatched })).not.toContain(linkedKey);
    expect(await treeDigest(root)).toEqual(before);
    expect(await Bun.file(join(root, ".gitignore")).exists()).toBe(false);
  });

  test("reports a changed LocalSecrets file as stale without repairing it", async () => {
    const originalKey = publishableKey("original.clerk.example");
    const changedKey = publishableKey("changed.clerk.example");
    const root = await fixture(originalKey);
    const plan = await runtimeKey.planIOSRuntimeKeyVerification(options(root));
    await Bun.write(join(root, "MyApp", "LocalSecrets.plist"), plistSource(changedKey));
    const changedTree = await treeDigest(root);

    const result = await runtimeKey.verifyIOSRuntimeKey(plan, changedKey);

    expect(result.status).toBe("stale");
    expect(await treeDigest(root)).toEqual(changedTree);
    expect(await Bun.file(join(root, ".gitignore")).exists()).toBe(false);
  });

  test("diagnoses an invalid Quickstart placeholder without filling it in", async () => {
    const root = await fixture("pk_test_...");
    const before = await treeDigest(root);

    const plan = await runtimeKey.planIOSRuntimeKeyVerification(options(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("invalid-publishable-key");
    expect(await treeDigest(root)).toEqual(before);
    expect(await Bun.file(join(root, ".gitignore")).exists()).toBe(false);
  });

  test("does not generalize compatibility to a renamed secrets plist", async () => {
    const key = publishableKey("renamed.clerk.example");
    const root = await fixture(key);
    await rename(
      join(root, "MyApp", "LocalSecrets.plist"),
      join(root, "MyApp", "ApplicationSecrets.plist"),
    );

    const sourcePath = join(root, "MyApp", "MyAppApp.swift");
    const source = await Bun.file(sourcePath).text();
    await Bun.write(
      sourcePath,
      source.replace('forResource: "LocalSecrets"', 'forResource: "ApplicationSecrets"'),
    );

    const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const project = await Bun.file(projectPath).text();
    await Bun.write(
      projectPath,
      project.replace("path = LocalSecrets.plist;", "path = ApplicationSecrets.plist;"),
    );
    const before = await treeDigest(root);

    const plan = await runtimeKey.planIOSRuntimeKeyVerification(options(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("unproven-runtime-wiring");
    expect(await treeDigest(root)).toEqual(before);
  });

  test("rejects invalid and production linked keys without serializing them", async () => {
    const localKey = publishableKey("development.clerk.example");
    const productionKey = publishableKey("production.clerk.example", true);
    const invalidKey = "pk_test_...";
    const root = await fixture(localKey);
    const plan = await runtimeKey.planIOSRuntimeKeyVerification(options(root));

    const invalid = await runtimeKey.verifyIOSRuntimeKey(plan, invalidKey);
    const production = await runtimeKey.verifyIOSRuntimeKey(plan, productionKey);

    expect(invalid.status).toBe("blocked");
    expect(invalid.plan.blockers[0]?.code).toBe("invalid-publishable-key");
    expect(production.status).toBe("blocked");
    expect(production.plan.blockers[0]?.code).toBe("production-publishable-key");
    expect(JSON.stringify({ invalid, production })).not.toContain(localKey);
    expect(JSON.stringify({ invalid, production })).not.toContain(productionKey);
    expect(JSON.stringify({ invalid, production })).not.toContain(invalidKey);
  });
});
