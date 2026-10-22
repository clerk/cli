import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as listage from "../../../lib/listage.ts";
import { log } from "../../../lib/log.ts";
import * as coordinator from "./coordinator.ts";
import * as xcodeTools from "./xcode-tools.ts";
import * as teams from "./teams.ts";
import { promptAppleStarter, type AppleStarterOptions } from "./starter-bootstrap.ts";

const PAID = { id: "COMPANY001", name: "Acme", personal: false };
const OTHER_PAID = { id: "COMPANY002", name: "Globex", personal: false };
const PERSONAL = { id: "PERSONAL01", name: "Sean Perez", personal: true };

let tmp: string;
const spies: { mockRestore(): void }[] = [];

function xcode(defaults: teams.XcodeDefaults) {
  spies.push(spyOn(teams, "readXcodeDefaults").mockReturnValue(defaults));
}

const run = (options: Partial<AppleStarterOptions>, platform: "ios" | "macos" = "ios") =>
  promptAppleStarter(tmp, platform, { skipConfirm: true, ...options });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "clerk-apple-starter-"));
  spies.push(spyOn(coordinator, "canSetUpXcode").mockReturnValue(true));
  // The selected Xcode is new enough.
  spies.push(spyOn(xcodeTools, "compatibleXcode").mockResolvedValue(undefined));
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  rmSync(tmp, { recursive: true, force: true });
});

describe("promptAppleStarter", () => {
  test("writes the project with the flags' identity", async () => {
    xcode({ teams: [PAID] });
    const result = await run({
      name: "MyApp",
      bundleId: "com.example.MyApp",
      teamId: "COMPANY001",
    });
    expect(result).toEqual({
      projectDir: join(tmp, "MyApp"),
      projectName: "MyApp",
      apple: {
        platform: "ios",
        bundleIdentifier: "com.example.MyApp",
        teamId: "COMPANY001",
        personalTeam: false,
      },
    });
    const pbxproj = readFileSync(join(tmp, "MyApp/MyApp.xcodeproj/project.pbxproj"), "utf8");
    expect(pbxproj).toContain("DEVELOPMENT_TEAM = COMPANY001;");
    expect(pbxproj).toContain("PRODUCT_BUNDLE_IDENTIFIER = com.example.MyApp;");
  });

  test("defaults the name and the Bundle ID from Xcode's Organization Identifier", async () => {
    xcode({ teams: [PAID], bundleIdentifierPrefix: "com.acme" });
    const result = await run({});
    expect(result.projectName).toBe("MyClerkApp");
    expect(result.apple.bundleIdentifier).toBe("com.acme.MyClerkApp");
  });

  test("turns underscores in --name into hyphens for the default Bundle ID", async () => {
    xcode({ teams: [PAID], bundleIdentifierPrefix: "com.acme" });
    const result = await run({ name: "My_App" });
    expect(result.apple.bundleIdentifier).toBe("com.acme.My-App");
    expect(readFileSync(join(tmp, "My_App/My_App.xcodeproj/project.pbxproj"), "utf8")).toContain(
      'PRODUCT_BUNDLE_IDENTIFIER = "com.acme.My-App";',
    );
  });

  test("asks for --bundle-id when Xcode's Organization Identifier isn't a valid prefix", async () => {
    xcode({ teams: [PAID], bundleIdentifierPrefix: "com.acme." });
    await expect(run({ name: "MyApp" })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("--bundle-id is required"),
    });
    expect(existsSync(join(tmp, "MyApp"))).toBe(false);
  });

  test.each([
    ["ios", "runs the app in the simulator"],
    ["macos", "runs the app on this Mac without Associated Domains"],
  ] as const)("explains what a Personal Team allows on %s", async (platform, note) => {
    xcode({ teams: [PERSONAL] });
    const info = spyOn(log, "info");
    spies.push(info);
    await run({ bundleId: "com.example.MyApp" }, platform);
    expect(info.mock.calls.flat().join("\n")).toContain(note);
  });

  test("skips a default name that's taken", async () => {
    xcode({ teams: [PAID], bundleIdentifierPrefix: "com.acme" });
    mkdirSync(join(tmp, "MyClerkApp"));
    expect((await run({})).projectName).toBe("MyClerkApp2");
  });

  test("uses the only paid team when it isn't asked", async () => {
    xcode({ teams: [PAID, PERSONAL] });
    expect((await run({ bundleId: "com.example.MyApp" })).apple.teamId).toBe("COMPANY001");
  });

  test("uses a Personal Team when it's the only team", async () => {
    xcode({ teams: [PERSONAL] });
    const { apple } = await run({ bundleId: "com.example.MyApp" });
    expect(apple).toMatchObject({ teamId: "PERSONAL01", personalTeam: true });
  });

  test("marks a --team-id that Xcode lists as a Personal Team", async () => {
    xcode({ teams: [PAID, PERSONAL] });
    const { apple } = await run({ bundleId: "com.example.MyApp", teamId: "PERSONAL01" });
    expect(apple.personalTeam).toBe(true);
  });

  test("accepts a --team-id Xcode doesn't list", async () => {
    xcode({ teams: [] });
    const { apple } = await run({ bundleId: "com.example.MyApp", teamId: "UNLISTED01" });
    expect(apple).toMatchObject({ teamId: "UNLISTED01", personalTeam: false });
  });

  test("creates a macOS app", async () => {
    xcode({ teams: [PAID] });
    const result = await run({ bundleId: "com.example.MyApp" }, "macos");
    expect(result.apple.platform).toBe("macos");
    expect(
      readFileSync(join(tmp, "MyClerkApp/MyClerkApp.xcodeproj/project.pbxproj"), "utf8"),
    ).toContain("SDKROOT = macosx;");
  });

  test.each([
    ["two paid teams", [PAID, OTHER_PAID], "Choose the Apple Developer team with --team-id"],
    ["no team", [], "No Apple Developer team found in Xcode"],
  ] as const)("asks for --team-id with %s", async (_, list, message) => {
    xcode({ teams: [...list] });
    await expect(run({ bundleId: "com.example.MyApp" })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining(message),
    });
    expect(existsSync(join(tmp, "MyClerkApp"))).toBe(false);
  });

  test("asks for --bundle-id when Xcode has no Organization Identifier", async () => {
    xcode({ teams: [PAID] });
    await expect(run({})).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("--bundle-id is required"),
    });
  });

  test.each([
    ["name", { name: "my-app" }, 'Invalid --name "my-app"'],
    ["name starting with an underscore", { name: "_App" }, 'Invalid --name "_App"'],
    [
      "Bundle ID over 255 characters",
      { bundleId: `com.example.${"a".repeat(250)}` },
      "Invalid --bundle-id",
    ],
    ["Bundle ID", { bundleId: "myapp" }, 'Invalid --bundle-id "myapp"'],
    ["Team ID", { bundleId: "com.example.MyApp", teamId: "abc" }, 'Invalid --team-id "abc"'],
  ] as const)("rejects an invalid %s before writing anything", async (_, options, message) => {
    xcode({ teams: [PAID] });
    await expect(run(options)).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining(message),
    });
    expect(existsSync(join(tmp, "my-app"))).toBe(false);
    expect(existsSync(join(tmp, "MyClerkApp"))).toBe(false);
  });

  test("rejects Sign in with Apple on a Personal Team before writing anything", async () => {
    xcode({ teams: [PERSONAL] });
    await expect(
      run({ bundleId: "com.example.MyApp", signInWithApple: true }),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining(
        "Sign in with Apple needs a paid Apple Developer Program team",
      ),
    });
    expect(existsSync(join(tmp, "MyClerkApp"))).toBe(false);
  });

  test("refuses a name whose directory exists", async () => {
    xcode({ teams: [PAID] });
    mkdirSync(join(tmp, "MyApp"));
    await expect(run({ name: "MyApp", bundleId: "com.example.MyApp" })).rejects.toMatchObject({
      message: expect.stringContaining("already exists"),
    });
  });

  test("labels each team once, marking a Personal Team simulator-only", async () => {
    xcode({ teams: [PAID, { ...PERSONAL, name: "Sean Perez (Personal Team)" }, OTHER_PAID] });
    let labels: string[] = [];
    spies.push(
      spyOn(listage, "select").mockImplementation(async (config) => {
        labels = config.choices.map((choice) => (choice as { name: string }).name);
        return PAID as never;
      }),
    );

    await run({ skipConfirm: false, name: "MyApp", bundleId: "com.example.MyApp" });

    expect(labels).toEqual([
      "Acme · COMPANY001",
      "Sean Perez (Personal Team) · PERSONAL01 · simulator only",
      "Globex · COMPANY002",
      "Enter a Team ID",
    ]);
  });

  test.each([
    [
      "no Xcode 26 is installed",
      () => Promise.reject(new Error("too old")),
      "needs Xcode 26 or later. Install it",
    ],
    [
      "an older Xcode is selected",
      () => Promise.resolve("/Applications/Xcode-26.app/Contents/Developer"),
      "sudo xcode-select -s /Applications/Xcode-26.app/Contents/Developer",
    ],
    [
      "the newer Xcode's path has a space",
      () => Promise.resolve("/Applications/Xcode 26.app/Contents/Developer"),
      "sudo xcode-select -s '/Applications/Xcode 26.app/Contents/Developer'`",
    ],
  ] as const)("stops before writing when %s", async (_, selection, message) => {
    xcode({ teams: [PAID] });
    spies.push(spyOn(xcodeTools, "compatibleXcode").mockImplementation(selection));
    await expect(run({ name: "MyApp", bundleId: "com.example.MyApp" })).rejects.toMatchObject({
      message: expect.stringContaining(message),
    });
    expect(existsSync(join(tmp, "MyApp"))).toBe(false);
  });

  test("needs Xcode", async () => {
    spies.push(spyOn(coordinator, "canSetUpXcode").mockReturnValue(false));
    await expect(run({ name: "MyApp" })).rejects.toMatchObject({
      message: expect.stringContaining("needs Xcode on macOS"),
    });
  });
});
