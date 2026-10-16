import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configuredPublishableKey, scanSwiftSources } from "./publishable-key.ts";
import type { Inspection } from "./xcode.ts";

const DEV = `pk_test_${btoa("fixture.clerk.accounts.dev$")}`;
const LIVE = `pk_live_${btoa("clerk.example.com$")}`;

const PLIST = (entries: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${entries}</dict></plist>\n`;

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "clerk-publishable-key-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// Test-case unions widen absent properties to undefined.
type Entries = Record<string, string | undefined>;
const defined = (entries: Entries = {}) =>
  Object.fromEntries(
    Object.entries(entries).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

async function write(files: Entries) {
  for (const [path, content] of Object.entries(defined(files))) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

function inspection(configuration: string, settings: Record<string, string> = {}): Inspection {
  return {
    contexts: [
      {
        selection: {
          root,
          project: "MyApp.xcodeproj",
          targetId: "T",
          targetName: "MyApp",
          configuration,
          sdk: "iphoneos",
        },
        settingsJSON: "[]",
        settings: { SRCROOT: root, CONFIGURATION: configuration, ...settings },
      },
    ],
  } as unknown as Inspection;
}

async function resolveKey(configuration: string, settings?: Entries) {
  const selected = inspection(configuration, defined(settings));
  return configuredPublishableKey(selected.contexts[0]!, await scanSwiftSources(selected));
}

const DEBUG_FLAGS = { SWIFT_ACTIVE_COMPILATION_CONDITIONS: "DEBUG" };

describe("resolved keys", () => {
  test.each([
    {
      name: "a literal passed to Clerk.configure",
      swift: `Clerk.configure(publishableKey: "${LIVE}")`,
      configuration: "Release",
      key: LIVE,
      source: "a string literal in MyApp/App.swift",
    },
    {
      name: "a raw-string literal with options",
      swift: `Clerk.configure(\n  publishableKey: #"${LIVE}"#,\n  options: .init()\n)`,
      configuration: "Release",
      key: LIVE,
      source: "a string literal in MyApp/App.swift",
    },
    {
      name: "the Release branch of #if DEBUG",
      swift: `#if DEBUG\nClerk.configure(publishableKey: "${DEV}")\n#else\nClerk.configure(publishableKey: "${LIVE}")\n#endif`,
      configuration: "Release",
      key: LIVE,
      source: "a string literal in MyApp/App.swift",
    },
    {
      name: "the Debug branch of #if DEBUG",
      swift: `#if DEBUG\nClerk.configure(publishableKey: "${DEV}")\n#else\nClerk.configure(publishableKey: "${LIVE}")\n#endif`,
      configuration: "Debug",
      settings: DEBUG_FLAGS,
      key: DEV,
      source: "a string literal in MyApp/App.swift",
    },
    {
      name: "a constant chosen with #if !DEBUG",
      swift: `enum Keys {\n#if !DEBUG\n  static let clerk = "${LIVE}"\n#else\n  static let clerk = "${DEV}"\n#endif\n}\nClerk.configure(publishableKey: Keys.clerk)`,
      configuration: "Release",
      key: LIVE,
      source: "a string literal in MyApp/App.swift",
    },
    {
      name: "a flag from OTHER_SWIFT_FLAGS",
      swift: `#if STAGING || DEBUG\nClerk.configure(publishableKey: "${DEV}")\n#else\nClerk.configure(publishableKey: "${LIVE}")\n#endif`,
      configuration: "Staging",
      settings: { OTHER_SWIFT_FLAGS: "$(inherited) -D STAGING" },
      key: DEV,
      source: "a string literal in MyApp/App.swift",
    },
    {
      name: "an Info.plist entry set by a build setting",
      swift: `let key = Bundle.main.object(forInfoDictionaryKey: "ClerkPublishableKey") as! String\nClerk.configure(publishableKey: key)`,
      plist: PLIST("<key>ClerkPublishableKey</key><string>$(CLERK_PUBLISHABLE_KEY)</string>"),
      configuration: "Release",
      settings: { INFOPLIST_FILE: "MyApp/Info.plist", CLERK_PUBLISHABLE_KEY: LIVE },
      key: LIVE,
      source:
        "the Info.plist entry ClerkPublishableKey, set by the CLERK_PUBLISHABLE_KEY build setting",
    },
    {
      name: "an Info.plist literal",
      swift: `Clerk.configure(publishableKey: Bundle.main.infoDictionary?["ClerkKey"] as? String ?? "")`,
      plist: PLIST(`<key>ClerkKey</key><string>${LIVE}</string>`),
      configuration: "Release",
      settings: { INFOPLIST_FILE: "MyApp/Info.plist" },
      key: LIVE,
      source: "the Info.plist entry ClerkKey",
    },
  ])("$name", async ({ swift, plist, configuration, settings, key, source }) => {
    await write({ "MyApp/App.swift": swift, ...(plist ? { "MyApp/Info.plist": plist } : {}) });
    expect(await resolveKey(configuration, settings)).toEqual({ status: "resolved", key, source });
  });
});

describe("unresolved keys", () => {
  test.each([
    {
      name: "no Clerk.configure call",
      files: { "MyApp/App.swift": "struct App {}" },
      reason: "no Clerk.configure(publishableKey:) call was found",
    },
    {
      name: "a call only in a comment or string",
      files: {
        "MyApp/App.swift": `// Clerk.configure(publishableKey: "${LIVE}")\nlet doc = "Clerk.configure(publishableKey: x)"`,
      },
      reason: "no Clerk.configure(publishableKey:) call was found",
    },
    {
      name: "a call only in the Debug branch",
      files: { "MyApp/App.swift": `#if DEBUG\nClerk.configure(publishableKey: "${DEV}")\n#endif` },
      reason: "no Clerk.configure call is compiled into Release",
    },
    {
      name: "a platform condition",
      files: {
        "MyApp/App.swift": `#if os(iOS)\nClerk.configure(publishableKey: "${LIVE}")\n#endif`,
      },
      reason: "compilation condition that depends on more than build flags",
    },
    {
      name: "two calls compiled into Release",
      files: {
        "MyApp/App.swift": `Clerk.configure(publishableKey: "${LIVE}")`,
        "MyApp/Other.swift": `Clerk.configure(publishableKey: "${DEV}")`,
      },
      reason: "2 Clerk.configure calls are compiled into Release",
    },
    {
      name: "a placeholder string",
      files: { "MyApp/App.swift": `Clerk.configure(publishableKey: "YOUR_KEY")` },
      reason: "is passed a string that isn't a publishable key",
    },
    {
      name: "an interpolated string",
      files: { "MyApp/App.swift": `Clerk.configure(publishableKey: "pk_live_\\(suffix)")` },
      reason: "loads its key in a way the CLI can't read without building",
    },
    {
      name: "the process environment",
      files: {
        "MyApp/App.swift": `Clerk.configure(publishableKey: ProcessInfo.processInfo.environment["CLERK_PUBLISHABLE_KEY"] ?? "")`,
      },
      reason: "loads its key in a way the CLI can't read without building",
    },
    {
      name: "a bundled secrets file",
      files: {
        "MyApp/App.swift": `Clerk.configure(publishableKey: LocalSecrets.load()["CLERK_PUBLISHABLE_KEY"] ?? "")`,
        "MyApp/LocalSecrets.plist": PLIST(
          `<key>CLERK_PUBLISHABLE_KEY</key><string>${LIVE}</string>`,
        ),
      },
      reason: "loads its key in a way the CLI can't read without building",
    },
    {
      name: "an Info.plist entry and a key literal both in reach",
      files: {
        "MyApp/App.swift": `let fallback = "${DEV}"\nClerk.configure(publishableKey: Bundle.main.object(forInfoDictionaryKey: "ClerkPublishableKey") as? String ?? fallback)`,
        "MyApp/Info.plist": PLIST(`<key>ClerkPublishableKey</key><string>${LIVE}</string>`),
      },
      settings: { INFOPLIST_FILE: "MyApp/Info.plist" },
      reason: "more than one publishable key could reach Clerk.configure in Release",
    },
    {
      name: "a preprocessed Info.plist",
      files: {
        "MyApp/App.swift": `Clerk.configure(publishableKey: Bundle.main.object(forInfoDictionaryKey: "ClerkPublishableKey") as! String)`,
        "MyApp/Info.plist": PLIST("<key>ClerkPublishableKey</key><string>CLERK_KEY</string>"),
      },
      settings: { INFOPLIST_FILE: "MyApp/Info.plist", INFOPLIST_PREPROCESS: "YES" },
      reason: "the Info.plist is preprocessed",
    },
  ])("$name", async ({ files, settings, reason }) => {
    await write(files);
    const result = await resolveKey("Release", settings);
    expect(result.status).toBe("unresolved");
    expect(result.status === "unresolved" && result.reason).toContain(reason);
  });
});

test("test bundles and build products are not scanned", async () => {
  await write({
    "MyApp/App.swift": `Clerk.configure(publishableKey: "${LIVE}")`,
    "MyAppTests/Setup.swift": `Clerk.configure(publishableKey: "${DEV}")`,
    "build/Generated.swift": `Clerk.configure(publishableKey: "${DEV}")`,
    ".build/checkouts/Other.swift": `Clerk.configure(publishableKey: "${DEV}")`,
  });
  expect(await resolveKey("Release")).toMatchObject({ status: "resolved", key: LIVE });
});
