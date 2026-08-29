import { afterAll, afterEach, test, expect, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ios } from "./ios.ts";
import type { ProjectContext } from "./types.ts";
import { createIOSFixture } from "../ios/test-helpers.ts";
import * as associatedDomain from "../ios/associated-domain.ts";

const temporaryRoots: string[] = [];
const emptyRoot = await mkdtemp(join(tmpdir(), "clerk-ios-framework-empty-"));

afterAll(() => rm(emptyRoot, { recursive: true, force: true }));

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeIOSFixture(complete: boolean, clerkSDK = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clerk-ios-framework-"));
  temporaryRoots.push(root);
  await createIOSFixture(root, { complete, clerkSDK });
  return root;
}

function makeCtx(): ProjectContext {
  return {
    cwd: emptyRoot,
    framework: {
      dep: "ios",
      name: "iOS (Swift)",
      sdk: "ClerkKit",
      envVar: "CLERK_PUBLISHABLE_KEY",
      envFile: ".env" as const,
      ecosystem: "swift" as const,
    },
    typescript: false,
    srcDir: false,
    packageManager: "npm",
    existingClerk: false,
    deps: {},
    envFile: ".env",
  };
}

test("matches only the ios framework", () => {
  const ctx = makeCtx();
  expect(ios.matches(ctx)).toBe(true);
  expect(ios.matches({ ...ctx, framework: { ...ctx.framework, dep: "android" } })).toBe(false);
});

test("writes no files and prints the quickstart steps", async () => {
  const plan = await ios.scaffold(makeCtx());

  expect(plan.actions).toHaveLength(0);
  expect(plan.postInstructions.some((i) => i.includes("github.com/clerk/clerk-ios"))).toBe(true);
  expect(
    plan.postInstructions.some((i) => i.includes("ClerkKit") && i.includes("ClerkKitUI")),
  ).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("prebuilt AuthView path"))).toBe(true);
  expect(
    plan.postInstructions.some((i) => i.includes("dashboard.clerk.com/~/native-applications")),
  ).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("Clerk.configure"))).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("signed-out authentication route"))).toBe(
    true,
  );
  expect(plan.postInstructions.some((i) => i.includes("--prebuilt-auth-ui"))).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes(".onOpenURL"))).toBe(false);
  // With no inspectable target, keep the guidance explicitly conditional.
  expect(plan.postInstructions.some((i) => i.includes(".environment(Clerk.shared)"))).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("docs/ios/getting-started/quickstart"))).toBe(
    true,
  );
});

test("uses direct @main configuration as the fresh-project default", async () => {
  const plan = await ios.scaffold({ ...makeCtx(), envFile: ".env.local" });

  expect(plan.postInstructions.some((i) => i.includes(".env.local"))).toBe(false);
  expect(plan.postInstructions.some((i) => i.includes("single shipping `@main` App"))).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("Clerk.configure"))).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("value redacted"))).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("LocalSecrets.plist"))).toBe(false);
  expect(
    plan.postInstructions.some(
      (i) => i.includes("Run scheme") && i.includes("manual runtime configuration"),
    ),
  ).toBe(false);
});

test("defers the Associated Domain host to ready direct configuration", async () => {
  const root = await makeIOSFixture(false);
  const unrelatedKey = `pk_test_${Buffer.from("unrelated-framework.clerk.example$").toString("base64")}`;
  await Bun.write(join(root, ".env"), `CLERK_PUBLISHABLE_KEY=${unrelatedKey}\n`);
  const planner = spyOn(associatedDomain, "planIOSAssociatedDomain");

  try {
    const plan = await ios.scaffold({ ...makeCtx(), cwd: root, iosTarget: "MyApp" });

    expect(planner).toHaveBeenCalledWith(
      expect.objectContaining({
        root,
        deferToPublishableKey: true,
      }),
    );
    expect(
      plan.postInstructions.some((instruction) => instruction.includes("Associated Domains")),
    ).toBe(true);
    expect(plan.postInstructions.join("\n")).not.toContain("unrelated-framework.clerk.example");
  } finally {
    planner.mockRestore();
  }
});

test("omits manual Native Applications guidance after authenticated remote verification", async () => {
  const plan = await ios.scaffold({ ...makeCtx(), iosNativeRemoteReady: true });

  expect(
    plan.postInstructions.some((instruction) =>
      instruction.includes("dashboard.clerk.com/~/native-applications"),
    ),
  ).toBe(false);
});

test("explains that the prebuilt AuthView exposes Apple automatically after native setup", async () => {
  const root = await makeIOSFixture(true);
  const plan = await ios.scaffold({
    ...makeCtx(),
    cwd: root,
    iosTarget: "MyApp",
    iosNativeRemoteReady: true,
    iosNativeAppleReady: true,
  });

  expect(
    plan.postInstructions.some(
      (instruction) =>
        instruction.includes("Native Sign in with Apple is ready") &&
        instruction.includes("AuthView displays the Apple button automatically"),
    ),
  ).toBe(true);
});

test("preserves a custom LocalSecrets loader without interpreting its value", async () => {
  const root = await mkdtemp(join(tmpdir(), "clerk-ios-framework-local-secrets-"));
  temporaryRoots.push(root);
  await createIOSFixture(root, { complete: true, includeKey: false, localSecrets: true });
  await Bun.write(
    join(root, "MyApp", "LocalSecrets.plist"),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CLERK_PUBLISHABLE_KEY</key><string>not-a-key</string></dict></plist>',
  );

  const plan = await ios.scaffold({ ...makeCtx(), cwd: root, iosTarget: "MyApp" });

  expect(plan.postInstructions.some((i) => i.includes("LocalSecrets.plist"))).toBe(false);
  expect(plan.postInstructions.some((i) => i.includes("custom key value"))).toBe(false);
  expect(
    plan.postInstructions.some((i) => i.includes("single shipping `@main` App initializer")),
  ).toBe(false);
  expect(plan.postInstructions.some((i) => i.includes(".env"))).toBe(false);
});

test("includes SwiftUI environment injection for the default prebuilt path", async () => {
  const root = await makeIOSFixture(false);
  const plan = await ios.scaffold({ ...makeCtx(), cwd: root, iosTarget: "MyApp" });

  expect(plan.postInstructions.some((i) => i.includes(".environment(Clerk.shared)"))).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("signed-out authentication route"))).toBe(
    true,
  );
});

test("keeps existing custom-flow installation and environment guidance core-only", async () => {
  const root = await makeIOSFixture(false, false);
  await Bun.write(
    join(root, "MyApp", "MyAppApp.swift"),
    `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  var body: some Scene { WindowGroup { Text("Custom auth") } }
}
`,
  );
  const plan = await ios.scaffold({ ...makeCtx(), cwd: root, iosTarget: "MyApp" });
  const installInstruction = plan.postInstructions.find((instruction) =>
    instruction.includes("github.com/clerk/clerk-ios"),
  );

  expect(installInstruction).toContain("link ClerkKit for this existing custom-flow path");
  expect(installInstruction).not.toContain("ClerkKitUI");
  expect(plan.postInstructions.some((i) => i.includes(".environment(Clerk.shared)"))).toBe(false);
  expect(plan.postInstructions.some((i) => i.includes("custom ClerkKit"))).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("ClerkKitUI's prebuilt AuthView"))).toBe(
    false,
  );
});

test("omits SwiftUI environment injection when it is already present", async () => {
  const root = await makeIOSFixture(true);
  const plan = await ios.scaffold({ ...makeCtx(), cwd: root, iosTarget: "MyApp" });

  expect(plan.postInstructions.some((i) => i.includes(".environment(Clerk.shared)"))).toBe(false);
});

test("does not derive setup state from a LocalSecrets value", async () => {
  const root = await mkdtemp(join(tmpdir(), "clerk-ios-framework-satisfied-"));
  temporaryRoots.push(root);
  await createIOSFixture(root, { complete: true, includeKey: false, localSecrets: true });
  const encodedHost = Buffer.from("clerk.example.test$").toString("base64");
  await Bun.write(
    join(root, "MyApp", "LocalSecrets.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CLERK_PUBLISHABLE_KEY</key><string>pk_test_${encodedHost}</string></dict></plist>`,
  );

  const plan = await ios.scaffold({ ...makeCtx(), cwd: root, iosTarget: "MyApp" });

  expect(plan.postInstructions.some((i) => i.includes("github.com/clerk/clerk-ios"))).toBe(false);
  expect(plan.postInstructions.some((i) => i.includes("Associated Domains"))).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("Configure Clerk"))).toBe(false);
  expect(plan.postInstructions.some((i) => i.includes("signed-out authentication route"))).toBe(
    false,
  );
  expect(plan.postInstructions.some((i) => i.includes(".environment(Clerk.shared)"))).toBe(false);
  expect(plan.postInstructions.some((i) => i.includes(".onOpenURL"))).toBe(false);
  expect(
    plan.postInstructions.some((i) => i.includes("dashboard.clerk.com/~/native-applications")),
  ).toBe(true);
});

test("only recommends callback wiring for a custom native email-link flow", async () => {
  const root = await makeIOSFixture(false);
  await Bun.write(
    join(root, "MyApp", "MyAppApp.swift"),
    `import ClerkKit
     import SwiftUI
     @main struct MyApp: App {
       var body: some Scene { WindowGroup { ContentView().environment(Clerk.shared) } }
     }
     func begin(_ signIn: SignIn) async throws { try await signIn.sendEmailLink() }`,
  );

  const magicLinkPlan = await ios.scaffold({ ...makeCtx(), cwd: root });
  expect(
    magicLinkPlan.postInstructions.some(
      (instruction) =>
        instruction.includes("custom native email-link flow") && instruction.includes("onOpenURL"),
    ),
  ).toBe(true);

  await Bun.write(
    join(root, "MyApp", "MyAppApp.swift"),
    `import ClerkKit
     import SwiftUI
     @main struct MyApp: App {
       var body: some Scene { WindowGroup { ContentView().environment(Clerk.shared) } }
     }
     func begin() async throws { try await Clerk.shared.auth.signInWithApple() }`,
  );
  const applePlan = await ios.scaffold({ ...makeCtx(), cwd: root });
  expect(applePlan.postInstructions.some((instruction) => instruction.includes("onOpenURL"))).toBe(
    false,
  );
});
