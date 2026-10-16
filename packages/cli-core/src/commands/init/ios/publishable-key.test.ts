import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredPublishableKey } from "./publishable-key.ts";
import type { Inspection } from "./xcode.ts";

const DEV = `pk_test_${btoa("fixture.clerk.accounts.dev$")}`;
const LIVE = `pk_live_${btoa("clerk.example.com$")}`;

const PLIST = (entries: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${entries}</dict></plist>\n`;
const BUILD_SETTING_ENTRY = PLIST(
  "<key>ClerkPublishableKey</key><string>$(CLERK_PUBLISHABLE_KEY)</string>",
);

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "clerk-publishable-key-")));
  await mkdir(join(root, "MyApp"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function context(configuration: string, settings: Record<string, string>) {
  const selection = { root, project: "MyApp.xcodeproj", targetName: "MyApp", configuration };
  return {
    selection,
    settingsJSON: "[]",
    settings: { SRCROOT: root, CONFIGURATION: configuration, ...settings },
  } as unknown as Inspection["contexts"][number];
}

async function resolveKey(
  configuration: string,
  settings: Record<string, string | undefined>,
  plist?: string,
) {
  if (plist !== undefined) await writeFile(join(root, "MyApp/Info.plist"), plist);
  const defined = Object.fromEntries(
    Object.entries(settings).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return configuredPublishableKey(context(configuration, defined));
}

test.each([
  ["Release", LIVE],
  ["Debug", DEV],
])(
  "%s resolves its CLERK_PUBLISHABLE_KEY build setting through Info.plist",
  async (configuration, key) => {
    expect(
      await resolveKey(
        configuration,
        { INFOPLIST_FILE: "MyApp/Info.plist", CLERK_PUBLISHABLE_KEY: key },
        BUILD_SETTING_ENTRY,
      ),
    ).toEqual({
      status: "resolved",
      key,
      source:
        "the Info.plist entry ClerkPublishableKey, set by the CLERK_PUBLISHABLE_KEY build setting",
    });
  },
);

test("resolves a literal Info.plist entry", async () => {
  expect(
    await resolveKey(
      "Release",
      { INFOPLIST_FILE: "MyApp/Info.plist" },
      PLIST(`<key>ClerkPublishableKey</key><string>${LIVE}</string>`),
    ),
  ).toEqual({ status: "resolved", key: LIVE, source: "the Info.plist entry ClerkPublishableKey" });
});

test.each([
  {
    name: "no Info.plist file (Xcode generates it)",
    settings: { GENERATE_INFOPLIST_FILE: "YES" },
    plist: undefined,
    reason: "the target has no Info.plist file for its ClerkPublishableKey entry",
  },
  {
    name: "an Info.plist without the entry",
    settings: { INFOPLIST_FILE: "MyApp/Info.plist" },
    plist: PLIST("<key>Other</key><string>value</string>"),
    reason: "the Info.plist has no ClerkPublishableKey string entry",
  },
  {
    name: "a preprocessed Info.plist",
    settings: { INFOPLIST_FILE: "MyApp/Info.plist", INFOPLIST_PREPROCESS: "YES" },
    plist: PLIST("<key>ClerkPublishableKey</key><string>CLERK_KEY</string>"),
    reason: "the Info.plist is preprocessed",
  },
  {
    name: "an Info.plist that isn't a plist",
    settings: { INFOPLIST_FILE: "MyApp/Info.plist" },
    plist: "not xml",
    reason: "the Info.plist could not be read",
  },
  {
    name: "a build setting that isn't set",
    settings: { INFOPLIST_FILE: "MyApp/Info.plist" },
    plist: BUILD_SETTING_ENTRY,
    reason:
      "reads the CLERK_PUBLISHABLE_KEY build setting, which isn't a publishable key in Release",
  },
  {
    name: "a placeholder entry",
    settings: { INFOPLIST_FILE: "MyApp/Info.plist" },
    plist: PLIST("<key>ClerkPublishableKey</key><string>YOUR_KEY</string>"),
    reason: "the Info.plist entry ClerkPublishableKey isn't a publishable key",
  },
])("reports $name as unresolved", async ({ settings, plist, reason }) => {
  const result = await resolveKey("Release", settings, plist);
  expect(result.status).toBe("unresolved");
  expect(result.status === "unresolved" && result.reason).toContain(reason);
});
