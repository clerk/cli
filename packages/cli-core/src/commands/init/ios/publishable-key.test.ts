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

// Two app targets, each compiling its own synchronized folder; MyApp leaves Excluded.swift out.
const PROJECT = `// !$*UTF8*$!
{
  archiveVersion = 1;
  classes = {};
  objectVersion = 77;
  objects = {
    AAAAAAAAAAAAAAAAAAAAAAAA = { isa = PBXProject; mainGroup = BBBBBBBBBBBBBBBBBBBBBBBB; targets = ( 111111111111111111111111, 222222222222222222222222 ); };
    BBBBBBBBBBBBBBBBBBBBBBBB = { isa = PBXGroup; children = ( CCCCCCCCCCCCCCCCCCCCCCCC, DDDDDDDDDDDDDDDDDDDDDDDD ); sourceTree = "<group>"; };
    CCCCCCCCCCCCCCCCCCCCCCCC = { isa = PBXFileSystemSynchronizedRootGroup; exceptions = ( EEEEEEEEEEEEEEEEEEEEEEEE ); path = MyApp; sourceTree = "<group>"; };
    EEEEEEEEEEEEEEEEEEEEEEEE = { isa = PBXFileSystemSynchronizedBuildFileExceptionSet; membershipExceptions = ( Excluded.swift ); target = 111111111111111111111111; };
    DDDDDDDDDDDDDDDDDDDDDDDD = { isa = PBXFileSystemSynchronizedRootGroup; path = AdminApp; sourceTree = "<group>"; };
    111111111111111111111111 = { isa = PBXNativeTarget; buildPhases = ( ); fileSystemSynchronizedGroups = ( CCCCCCCCCCCCCCCCCCCCCCCC ); name = MyApp; };
    222222222222222222222222 = { isa = PBXNativeTarget; buildPhases = ( ); fileSystemSynchronizedGroups = ( DDDDDDDDDDDDDDDDDDDDDDDD ); name = AdminApp; };
  };
  rootObject = AAAAAAAAAAAAAAAAAAAAAAAA;
}
`;

function inspection(configuration: string, settings: Record<string, string> = {}): Inspection {
  const selection = {
    root,
    project: "MyApp.xcodeproj",
    targetId: "111111111111111111111111",
    targetName: "MyApp",
    configuration,
    sdk: "iphoneos",
  };
  return {
    document: { path: "MyApp.xcodeproj/project.pbxproj", source: PROJECT },
    input: { selection, projectFormat: "pbxproj" },
    contexts: [
      {
        selection,
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
      name: "an Info.plist entry set by a build setting",
      swift: `Clerk.configure(publishableKey: Bundle.main.object(forInfoDictionaryKey: "ClerkPublishableKey") as! String)`,
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
      name: "two calls compiled into Release",
      files: {
        "MyApp/App.swift": `Clerk.configure(publishableKey: "${LIVE}")`,
        "MyApp/Other.swift": `Clerk.configure(publishableKey: "${DEV}")`,
      },
      reason: "the target's Swift sources have 2 Clerk.configure calls",
    },
    {
      name: "the branches of #if DEBUG",
      files: {
        "MyApp/App.swift": `#if DEBUG\nClerk.configure(publishableKey: "${DEV}")\n#else\nClerk.configure(publishableKey: "${LIVE}")\n#endif`,
      },
      reason: "Clerk.configure is inside an #if block",
    },
    {
      name: "a platform condition",
      files: {
        "MyApp/App.swift": `#if os(iOS)\nClerk.configure(publishableKey: "${LIVE}")\n#endif`,
      },
      reason: "Clerk.configure is inside an #if block",
    },
    {
      name: "a constant",
      files: { "MyApp/App.swift": `let key = "${LIVE}"\nClerk.configure(publishableKey: key)` },
      reason: "gets its key from code the CLI doesn't read",
    },
    {
      name: "a constant read from Info.plist",
      files: {
        "MyApp/App.swift": `let key = Bundle.main.object(forInfoDictionaryKey: "ClerkPublishableKey") as! String\nClerk.configure(publishableKey: key)`,
        "MyApp/Info.plist": PLIST(`<key>ClerkPublishableKey</key><string>${LIVE}</string>`),
      },
      settings: { INFOPLIST_FILE: "MyApp/Info.plist" },
      reason: "gets its key from code the CLI doesn't read",
    },
    {
      name: "a source file too large to scan",
      files: {
        "MyApp/App.swift": `Clerk.configure(publishableKey: "${LIVE}")`,
        "MyApp/Generated.swift": `// ${"x".repeat(1_000_001)}`,
      },
      reason: "MyApp/Generated.swift is too large to scan",
    },
    {
      name: "a placeholder string",
      files: { "MyApp/App.swift": `Clerk.configure(publishableKey: "YOUR_KEY")` },
      reason: "is passed a string that isn't a publishable key",
    },
    {
      name: "an interpolated string",
      files: { "MyApp/App.swift": `Clerk.configure(publishableKey: "pk_live_\\(suffix)")` },
      reason: "gets its key from code the CLI doesn't read",
    },
    {
      name: "the process environment",
      files: {
        "MyApp/App.swift": `Clerk.configure(publishableKey: ProcessInfo.processInfo.environment["CLERK_PUBLISHABLE_KEY"] ?? "")`,
      },
      reason: "gets its key from code the CLI doesn't read",
    },
    {
      name: "a bundled secrets file",
      files: {
        "MyApp/App.swift": `Clerk.configure(publishableKey: LocalSecrets.load()["CLERK_PUBLISHABLE_KEY"] ?? "")`,
        "MyApp/LocalSecrets.plist": PLIST(
          `<key>CLERK_PUBLISHABLE_KEY</key><string>${LIVE}</string>`,
        ),
      },
      reason: "gets its key from code the CLI doesn't read",
    },
    {
      name: "an Info.plist read with a key fallback",
      files: {
        "MyApp/App.swift": `let fallback = "${DEV}"\nClerk.configure(publishableKey: Bundle.main.object(forInfoDictionaryKey: "ClerkPublishableKey") as? String ?? fallback)`,
        "MyApp/Info.plist": PLIST(`<key>ClerkPublishableKey</key><string>${LIVE}</string>`),
      },
      settings: { INFOPLIST_FILE: "MyApp/Info.plist" },
      reason: "gets its key from code the CLI doesn't read",
    },
    {
      name: "an environment override with a production fallback",
      files: {
        "MyApp/App.swift": `Clerk.configure(publishableKey: ProcessInfo.processInfo.environment["KEY"] ?? "${LIVE}")`,
      },
      reason: "gets its key from code the CLI doesn't read",
    },
    {
      name: "a constant with an environment override",
      files: {
        "MyApp/App.swift": `let key = ProcessInfo.processInfo.environment["KEY"] ?? "${LIVE}"\nClerk.configure(publishableKey: key)`,
      },
      reason: "gets its key from code the CLI doesn't read",
    },
    {
      name: "an Info.plist entry missing from the file",
      files: {
        "MyApp/App.swift": `Clerk.configure(publishableKey: Bundle.main.object(forInfoDictionaryKey: "ClerkPublishableKey") as! String)`,
        "MyApp/Info.plist": PLIST("<key>Other</key><string>value</string>"),
      },
      settings: { INFOPLIST_FILE: "MyApp/Info.plist" },
      reason: "the Info.plist has no ClerkPublishableKey string entry",
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

test.each([
  {
    name: "another target's sources",
    files: { "AdminApp/AdminApp.swift": `Clerk.configure(publishableKey: "${DEV}")` },
  },
  {
    name: "a file the target excludes from its synchronized folder",
    files: { "MyApp/Excluded.swift": `Clerk.configure(publishableKey: "${DEV}")` },
  },
  {
    name: "a file the configuration excludes",
    files: { "MyApp/Debug/DebugKey.swift": `Clerk.configure(publishableKey: "${DEV}")` },
    settings: { EXCLUDED_SOURCE_FILE_NAMES: "*/Debug/*" },
  },
  {
    name: "files outside the project",
    files: {
      "MyAppTests/Setup.swift": `Clerk.configure(publishableKey: "${DEV}")`,
      "build/Generated.swift": `Clerk.configure(publishableKey: "${DEV}")`,
    },
  },
])("ignores $name", async ({ files, settings }) => {
  await write({ "MyApp/App.swift": `Clerk.configure(publishableKey: "${LIVE}")`, ...files });
  expect(await resolveKey("Release", settings)).toMatchObject({ status: "resolved", key: LIVE });
});
