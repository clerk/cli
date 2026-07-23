import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expo, wrapLastReturnWithProvider } from "./expo.ts";
import type { FileAction, ProjectContext } from "./types.ts";

let tempDir: string;

function makeCtx(overrides?: Partial<ProjectContext>): ProjectContext {
  return {
    cwd: tempDir,
    framework: {
      dep: "expo",
      name: "Expo",
      sdk: "@clerk/expo",
      envVar: "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
      envFile: ".env.local" as const,
    },
    typescript: true,
    srcDir: false,
    packageManager: "npm",
    existingClerk: false,
    deps: { expo: "~52.0.0", "expo-router": "~4.0.0" },
    envFile: ".env",
    ...overrides,
  };
}

function findAction(actions: FileAction[], path: string): FileAction {
  const action = actions.find((a) => a.path === path);
  if (!action) {
    const paths = actions.map((a) => a.path).join(", ");
    throw new Error(`No action found for path "${path}". Available: ${paths}`);
  }
  return action;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "clerk-expo-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const ROUTER_LAYOUT = `import { Stack } from "expo-router";
import { useFonts } from "expo-font";

export default function RootLayout() {
  const [loaded] = useFonts({});

  if (!loaded) {
    return null;
  }

  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}
`;

test("creates app/_layout.tsx when missing and expo-router is present", async () => {
  const plan = await expo.scaffold(makeCtx());

  const layout = findAction(plan.actions, "app/_layout.tsx");
  expect(layout.type).toBe("create");
  if (layout.type === "create") {
    expect(layout.content).toContain('import { ClerkProvider } from "@clerk/expo"');
    expect(layout.content).toContain('import { tokenCache } from "@clerk/expo/token-cache"');
    expect(layout.content).toContain("<Slot />");
    expect(layout.content).toContain("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY");
    // Guard message points at the env file init actually writes to
    expect(layout.content).toContain("Add your key to .env.");
  }
});

test("guard message references the project's env file", async () => {
  const plan = await expo.scaffold(makeCtx({ envFile: ".env.local" }));

  const layout = findAction(plan.actions, "app/_layout.tsx");
  if (layout.type === "create") {
    expect(layout.content).toContain("Add your key to .env.local.");
  }
});

test("creates src/app/_layout.tsx when srcDir is true", async () => {
  const plan = await expo.scaffold(makeCtx({ srcDir: true }));

  expect(findAction(plan.actions, "src/app/_layout.tsx").type).toBe("create");
});

test("creates _layout.jsx when typescript is false", async () => {
  const plan = await expo.scaffold(makeCtx({ typescript: false }));

  expect(findAction(plan.actions, "app/_layout.jsx").type).toBe("create");
});

test("does not create a layout without expo-router — prints post-instruction", async () => {
  const plan = await expo.scaffold(makeCtx({ deps: { expo: "~52.0.0" } }));

  expect(plan.actions).toHaveLength(0);
  expect(plan.postInstructions.some((i) => i.includes("ClerkProvider"))).toBe(true);
});

test("wraps the main return of an existing layout, not the guard return", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/_layout.tsx"), ROUTER_LAYOUT);

  const plan = await expo.scaffold(makeCtx());

  const layout = findAction(plan.actions, "app/_layout.tsx");
  expect(layout.type).toBe("modify");
  if (layout.type === "modify") {
    expect(layout.content).toContain(
      "<ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>",
    );
    expect(layout.content).toContain("</ClerkProvider>");
    expect(layout.content).toContain("@clerk/expo/token-cache");
    expect(layout.content).toContain("process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY");
    // Guard return stays untouched
    expect(layout.content).toContain("return null;");
    // The provider wraps the Stack, not the guard
    const providerIdx = layout.content.indexOf("<ClerkProvider");
    const stackIdx = layout.content.indexOf("<Stack>");
    expect(providerIdx).toBeLessThan(stackIdx);
  }
});

test("wraps a single-line return without parentheses", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/_layout.tsx"),
    `import { Slot } from "expo-router";

export default function RootLayout() {
  return <Slot />;
}
`,
  );

  const plan = await expo.scaffold(makeCtx());

  const layout = findAction(plan.actions, "app/_layout.tsx");
  expect(layout.type).toBe("modify");
  if (layout.type === "modify") {
    expect(layout.content).toContain("<ClerkProvider");
    expect(layout.content).toContain("<Slot />");
  }
});

test("skips when layout already has ClerkProvider", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/_layout.tsx"),
    `import { ClerkProvider } from "@clerk/expo";
export default function RootLayout() {
  return <ClerkProvider><Slot /></ClerkProvider>;
}
`,
  );

  const plan = await expo.scaffold(makeCtx());

  expect(findAction(plan.actions, "app/_layout.tsx")).toMatchObject({
    type: "skip",
    skipReason: "Already has ClerkProvider",
  });
});

test("skips with reason when layout has no JSX return", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/_layout.tsx"),
    `export default function RootLayout() {
  return null;
}
`,
  );

  const plan = await expo.scaffold(makeCtx());

  const layout = findAction(plan.actions, "app/_layout.tsx");
  expect(layout.type).toBe("skip");
});

test("recommends expo install for expo-secure-store when layout is written", async () => {
  const plan = await expo.scaffold(makeCtx());

  expect(plan.postInstructions.some((i) => i.includes("npx expo install expo-secure-store"))).toBe(
    true,
  );
});

test("does not recommend expo-secure-store when already installed", async () => {
  const plan = await expo.scaffold(
    makeCtx({
      deps: { expo: "~52.0.0", "expo-router": "~4.0.0", "expo-secure-store": "~14.0.0" },
    }),
  );

  expect(plan.postInstructions.some((i) => i.includes("expo-secure-store"))).toBe(false);
});

test("includes env var and Native API post-instructions", async () => {
  const plan = await expo.scaffold(makeCtx());

  expect(plan.postInstructions.some((i) => i.includes("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY"))).toBe(
    true,
  );
  expect(plan.postInstructions.some((i) => i.includes("native-applications"))).toBe(true);
});

test("wrapLastReturnWithProvider returns null for non-JSX content", () => {
  expect(wrapLastReturnWithProvider("const x = 1;")).toBeNull();
});
