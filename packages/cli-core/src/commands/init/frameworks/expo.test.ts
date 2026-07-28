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

test("adds spaced, ordered imports when modifying an existing layout", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/_layout.tsx"), ROUTER_LAYOUT);

  const plan = await expo.scaffold(makeCtx());

  const layout = findAction(plan.actions, "app/_layout.tsx");
  expect(layout.type).toBe("modify");
  if (layout.type === "modify") {
    expect(layout.content).toContain('import { ClerkProvider } from "@clerk/expo"');
    expect(layout.content).toContain('import { tokenCache } from "@clerk/expo/token-cache"');
    // Provider import reads first, matching the create-path template
    expect(layout.content.indexOf('from "@clerk/expo"')).toBeLessThan(
      layout.content.indexOf('from "@clerk/expo/token-cache"'),
    );
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

test("wraps the default export's return, not a later ErrorBoundary export", () => {
  const content = `import { Slot } from "expo-router";
import { View, Text } from "react-native";

export default function RootLayout() {
  return (
    <Slot />
  );
}

export function ErrorBoundary({ error }: { error: Error }) {
  return (
    <View>
      <Text>{error.message}</Text>
    </View>
  );
}
`;

  const wrapped = wrapLastReturnWithProvider(content)!;
  expect(wrapped).not.toBeNull();
  // Exactly one wrap, and it lands on the root layout's Slot
  expect(wrapped.match(/<ClerkProvider/g)).toHaveLength(1);
  const providerIdx = wrapped.indexOf("<ClerkProvider");
  expect(providerIdx).toBeLessThan(wrapped.indexOf("<Slot />"));
  expect(providerIdx).toBeLessThan(wrapped.indexOf("ErrorBoundary"));
  // The error boundary's JSX is untouched
  expect(wrapped).toContain("return (\n    <View>");
});

test("wraps a layout whose own JSX text contains an apostrophe", () => {
  const content = `import { Slot } from "expo-router";
import { Text, View } from "react-native";

export default function RootLayout() {
  return (
    <View>
      <Text>Don't panic</Text>
      <Slot />
    </View>
  );
}
`;

  const wrapped = wrapLastReturnWithProvider(content)!;
  expect(wrapped).not.toBeNull();
  expect(wrapped).toContain("<ClerkProvider");
  expect(wrapped).toContain("<Text>Don't panic</Text>");
  expect(wrapped.indexOf("<ClerkProvider")).toBeLessThan(wrapped.indexOf("<View>"));
});

test("wraps the root layout even when earlier JSX text contains an apostrophe", () => {
  const content = `import { Slot } from "expo-router";
import { View, Text } from "react-native";

function Banner() {
  return (
    <Text>Don't panic</Text>
  );
}

export default function RootLayout() {
  return (
    <View>
      <Banner />
      <Slot />
    </View>
  );
}
`;

  const wrapped = wrapLastReturnWithProvider(content)!;
  expect(wrapped).not.toBeNull();
  expect(wrapped.match(/<ClerkProvider/g)).toHaveLength(1);
  // The provider wraps the root layout's tree, not the Banner above it
  const providerIdx = wrapped.indexOf("<ClerkProvider");
  expect(providerIdx).toBeGreaterThan(wrapped.indexOf("function Banner"));
  expect(providerIdx).toBeLessThan(wrapped.indexOf("<Slot />"));
  expect(wrapped).toContain("<Text>Don't panic</Text>");
});

test("wraps the last single-line return, not a single-line guard", () => {
  const content = `import { Slot } from "expo-router";

export default function RootLayout() {
  const isLoaded = false;
  if (!isLoaded) return <Loading />;
  return <Slot />;
}
`;

  const wrapped = wrapLastReturnWithProvider(content)!;
  expect(wrapped).not.toBeNull();
  // The guard stays untouched; the main render gets wrapped
  expect(wrapped).toContain("if (!isLoaded) return <Loading />;");
  const providerIdx = wrapped.indexOf("<ClerkProvider");
  expect(providerIdx).toBeGreaterThan(wrapped.indexOf("<Loading />"));
  expect(wrapped.indexOf("<Slot />")).toBeGreaterThan(providerIdx);
});

test("inserts the key block after a multi-line import, not inside it", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/_layout.tsx"),
    `import { Slot } from "expo-router";
import {
  useFonts,
} from "expo-font";

export default function RootLayout() {
  return (
    <Slot />
  );
}
`,
  );

  const plan = await expo.scaffold(makeCtx());

  const layout = findAction(plan.actions, "app/_layout.tsx");
  expect(layout.type).toBe("modify");
  if (layout.type === "modify") {
    // The multi-line import survives intact…
    expect(layout.content).toContain('} from "expo-font";');
    // …and the key block lands after it, not spliced between its braces
    const keyIdx = layout.content.indexOf("const publishableKey");
    expect(keyIdx).toBeGreaterThan(layout.content.indexOf('} from "expo-font";'));
  }
});

// Arrow-function layouts are the common React Native shape. When the default
// export can't be resolved the search used to fall back to the whole file,
// which put <ClerkProvider> inside a sibling ErrorBoundary and left the real
// layout unwrapped — scaffolded-looking output where every Clerk hook throws.
test.each([
  {
    name: "an arrow function reached through `export default Name`",
    body: `const RootLayout = () => {
  return (
    <Slot />
  );
};

export default RootLayout;`,
  },
  {
    name: "an inline arrow default export",
    body: `export default () => {
  return (
    <Slot />
  );
};`,
  },
  {
    name: "an async arrow with props",
    body: `export default async (props) => {
  return (
    <Slot />
  );
};`,
  },
  {
    name: "a typed arrow reached through `export default Name`",
    body: `const RootLayout: React.FC = () => {
  return (
    <Slot />
  );
};

export default RootLayout;`,
  },
  {
    name: "a function expression reached through `export default Name`",
    body: `const RootLayout = function () {
  return (
    <Slot />
  );
};

export default RootLayout;`,
  },
])("wraps the root layout, not ErrorBoundary, for $name", ({ body }) => {
  const content = `import { Slot } from "expo-router";

${body}

export function ErrorBoundary({ error }: { error: Error }) {
  return (
    <Text>{error.message}</Text>
  );
}
`;

  const wrapped = wrapLastReturnWithProvider(content)!;
  expect(wrapped).not.toBeNull();
  expect(wrapped.match(/<ClerkProvider/g)).toHaveLength(1);
  expect(wrapped.indexOf("<ClerkProvider")).toBeLessThan(wrapped.indexOf("ErrorBoundary"));
  // The error boundary's own render is untouched.
  expect(wrapped).toContain("return (\n    <Text>{error.message}</Text>\n  );");
});

// Failing closed produces an honest "unsupported shape" skip plus a
// post-instruction, which beats wrapping whatever return happens to be last.
test.each([
  {
    name: "a HOC-wrapped default export",
    content: `function RootLayout() {
  return (
    <Slot />
  );
}

export default withFoo(RootLayout);
`,
  },
  {
    name: "a concise arrow body with no return to wrap",
    content: `export default () => (
  <Slot />
);
`,
  },
  {
    name: "a default export referencing an unresolvable binding",
    content: `export default Layouts.Root;
`,
  },
])("returns null rather than guessing for $name", ({ content }) => {
  expect(wrapLastReturnWithProvider(content)).toBeNull();
});

test("wraps a single-line return that has a trailing comment, keeping the comment", () => {
  const content = `export default function RootLayout() {
  return <Slot name="main" />; // TODO: see docs -> here
}
`;

  const wrapped = wrapLastReturnWithProvider(content)!;
  expect(wrapped).not.toBeNull();
  expect(wrapped).toContain("<ClerkProvider");
  // The JSX is read back out of the real source, so its string attribute
  // survives the mask…
  expect(wrapped).toContain('<Slot name="main" />');
  // …and the trailing comment is not swallowed by the match.
  expect(wrapped).toContain("// TODO: see docs -> here");
});

test("does not skip a layout whose only ClerkProvider is in a comment", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/_layout.tsx"),
    `import { Slot } from "expo-router";

// TODO: wrap in <ClerkProvider>
export default function RootLayout() {
  return (
    <Slot />
  );
}
`,
  );

  const plan = await expo.scaffold(makeCtx());

  const layout = findAction(plan.actions, "app/_layout.tsx");
  expect(layout.type).toBe("modify");
  if (layout.type === "modify") {
    expect(layout.content).toContain("<ClerkProvider publishableKey=");
  }
});
