import { test, expect, describe, spyOn, afterAll, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOTSTRAP_REGISTRY } from "./bootstrap-registry.ts";
import * as listage from "../../lib/listage.ts";
import * as coordinator from "./ios/coordinator.ts";
import * as appleStarter from "./ios/starter-bootstrap.ts";
import {
  findAvailableProjectName,
  promptAndBootstrap,
  resolvePackageManager,
} from "./bootstrap.ts";

function entryFor(dep: string) {
  const entry = BOOTSTRAP_REGISTRY.find((e) => e.dep === dep);
  if (!entry) throw new Error(`No bootstrap entry for dep: ${dep}`);
  return entry;
}

describe("BOOTSTRAP_REGISTRY", () => {
  const packageManagers = ["npm", "yarn", "pnpm", "bun"] as const;

  test("contains all 9 supported frameworks", () => {
    expect(BOOTSTRAP_REGISTRY).toHaveLength(9);
    const deps = BOOTSTRAP_REGISTRY.map((e) => e.dep);
    expect(deps).toContain("next");
    expect(deps).toContain("react");
    expect(deps).toContain("vue");
    expect(deps).toContain("react-router");
    expect(deps).toContain("astro");
    expect(deps).toContain("nuxt");
    expect(deps).toContain("@tanstack/react-start");
    expect(deps).toContain("vite");
    expect(deps).toContain("expo");
  });

  const REGISTRY_PM_PAIRS = BOOTSTRAP_REGISTRY.flatMap((entry) =>
    packageManagers.map((pm) => ({ dep: entry.dep, entry, pm })),
  );

  test.each(REGISTRY_PM_PAIRS)(
    "entry $dep produces a non-empty string[] for package manager $pm",
    ({ entry, pm }) => {
      const cmd = entry.buildCommand(pm, "test-app");
      expect(cmd.length).toBeGreaterThan(0);
      expect(cmd.every((arg) => typeof arg === "string")).toBe(true);
    },
  );

  test("Next.js uses project name as target directory", () => {
    const cmd = entryFor("next").buildCommand("bun", "my-cool-app");
    expect(cmd[0]).toBe("bunx");
    expect(cmd).toContain("create-next-app@latest");
    expect(cmd).toContain("my-cool-app");
    expect(cmd).toContain("--yes");
    expect(cmd).toContain("--skip-install");
    expect(cmd).toContain("--disable-git");

    expect(entryFor("next").buildCommand("npm", "app")[0]).toBe("npx");
  });

  test("React uses project name as target directory", () => {
    const cmd = entryFor("react").buildCommand("pnpm", "my-app");
    expect(cmd).toContain("create-vite@latest");
    expect(cmd).toContain("my-app");
    expect(cmd).toContain("--template");
    expect(cmd).toContain("react-ts");
  });

  test("Vue uses create-vite with vue-ts template", () => {
    const cmd = entryFor("vue").buildCommand("npm", "my-vue");
    expect(cmd).toContain("create-vite@latest");
    expect(cmd).toContain("my-vue");
    expect(cmd).toContain("vue-ts");
  });

  test("Nuxt uses create-nuxt with --no-modules to suppress interactive prompt", () => {
    const cmd = entryFor("nuxt").buildCommand("bun", "my-nuxt");
    expect(cmd).toContain("create-nuxt@latest");
    expect(cmd).toContain("my-nuxt");
    expect(cmd).toContain("--no-modules");
    expect(cmd).toContain("--no-install");
    expect(cmd).toContain("--no-gitInit");
    expect(cmd).toContain("--packageManager");
    expect(cmd).toContain("bun");
  });

  test("TanStack uses project name as positional arg", () => {
    const cmd = entryFor("@tanstack/react-start").buildCommand("yarn", "my-app");
    expect(cmd[0]).toBe("yarn");
    expect(cmd[1]).toBe("dlx");
    expect(cmd).toContain("@tanstack/cli@latest");
    expect(cmd).toContain("create");
    expect(cmd).toContain("my-app");
    expect(cmd).toContain("--framework");
    expect(cmd).toContain("react");
    expect(cmd).toContain("--no-install");
    expect(cmd).toContain("--no-git");
  });

  test("React Router uses project name as target", () => {
    const cmd = entryFor("react-router").buildCommand("npm", "my-rr");
    expect(cmd).toContain("create-react-router@latest");
    expect(cmd).toContain("my-rr");
    expect(cmd).toContain("--yes");
    expect(cmd).toContain("--no-install");
    expect(cmd).toContain("--no-git-init");
  });

  test("Astro uses --yes for basics template with --skip-houston", () => {
    const cmd = entryFor("astro").buildCommand("bun", "my-astro");
    expect(cmd).toContain("create-astro@latest");
    expect(cmd).toContain("my-astro");
    expect(cmd).toContain("--yes");
    expect(cmd).toContain("--skip-houston");
    expect(cmd).toContain("--no-install");
    expect(cmd).toContain("--no-git");
  });

  test("Expo uses create-expo-app with default template", () => {
    const cmd = entryFor("expo").buildCommand("bun", "my-expo");
    expect(cmd[0]).toBe("bunx");
    expect(cmd).toContain("create-expo-app@latest");
    expect(cmd).toContain("my-expo");
    expect(cmd).toContain("--template");
    expect(cmd).toContain("default");
    expect(cmd).toContain("--no-install");
    expect(cmd).toContain("--yes");
  });

  test("JavaScript uses create-vite with vanilla template", () => {
    const cmd = entryFor("vite").buildCommand("npm", "my-js-app");
    expect(cmd).toContain("create-vite@latest");
    expect(cmd).toContain("my-js-app");
    expect(cmd).toContain("--template");
    expect(cmd).toContain("vanilla");
    expect(cmd).not.toContain("vanilla-ts");
  });

  test("yarn runner splits into two tokens", () => {
    const cmd = entryFor("react").buildCommand("yarn", "app");
    expect(cmd[0]).toBe("yarn");
    expect(cmd[1]).toBe("dlx");
  });

  test("pnpm runner splits into two tokens", () => {
    const cmd = entryFor("react").buildCommand("pnpm", "app");
    expect(cmd[0]).toBe("pnpm");
    expect(cmd[1]).toBe("dlx");
  });
});

describe("resolvePackageManager", () => {
  const whichSpy = spyOn(Bun, "which");

  afterAll(() => {
    whichSpy.mockRestore();
  });

  test("returns first available PM in priority order", () => {
    whichSpy.mockImplementation((bin) => {
      if (bin === "bun") return "/usr/local/bin/bun";
      return null;
    });

    expect(resolvePackageManager()).toBe("bun");
  });

  test("falls back to pnpm when bun is unavailable", () => {
    whichSpy.mockImplementation((bin) => {
      if (bin === "pnpm") return "/usr/local/bin/pnpm";
      return null;
    });

    expect(resolvePackageManager()).toBe("pnpm");
  });

  test("falls back to yarn when bun and pnpm are unavailable", () => {
    whichSpy.mockImplementation((bin) => {
      if (bin === "yarn") return "/usr/local/bin/yarn";
      return null;
    });

    expect(resolvePackageManager()).toBe("yarn");
  });

  test("falls back to npm as last resort", () => {
    whichSpy.mockReturnValue(null);

    expect(resolvePackageManager()).toBe("npm");
  });
});

describe("findAvailableProjectName", () => {
  test("returns the base name when no collision exists", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "clerk-bootstrap-"));
    try {
      expect(await findAvailableProjectName(tmp, "my-app")).toBe("my-app");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("increments suffix until an unused name is found", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "clerk-bootstrap-"));
    try {
      mkdirSync(join(tmp, "my-app"));
      mkdirSync(join(tmp, "my-app-2"));
      expect(await findAvailableProjectName(tmp, "my-app")).toBe("my-app-3");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("promptAndBootstrap", () => {
  test("throws a usage-exit CliError when skipConfirm is set without a framework override", async () => {
    await expect(
      promptAndBootstrap("/tmp", undefined, { skipConfirm: true }),
    ).rejects.toMatchObject({
      name: "CliError",
      exitCode: 2,
      message: expect.stringContaining("Non-interactive mode requires --framework"),
    });
  });

  test("nameOverride collision still throws (explicit name)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "clerk-bootstrap-"));
    try {
      mkdirSync(join(tmp, "my-app"));
      await expect(
        promptAndBootstrap(tmp, { name: "Next.js", dep: "next" } as never, {
          skipConfirm: true,
          nameOverride: "my-app",
        }),
      ).rejects.toMatchObject({
        name: "CliError",
        message: expect.stringContaining("already exists"),
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("guard still fires when implicitBootstrap is combined with skipConfirm", async () => {
    // --starter -y path: implicitBootstrap + skipConfirm. Guard still applies.
    await expect(
      promptAndBootstrap("/tmp", undefined, { skipConfirm: true, implicitBootstrap: true }),
    ).rejects.toMatchObject({
      name: "CliError",
      exitCode: 2,
      message: expect.stringContaining("--framework"),
    });
  });
});

describe("promptAndBootstrap for native Apple starters", () => {
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });
  const IOS = { name: "iOS (Swift)", dep: "ios" } as never;
  const APPLE_RESULT = {
    projectDir: "/tmp/MyApp",
    projectName: "MyApp",
    apple: {
      platform: "ios" as const,
      bundleIdentifier: "com.example.MyApp",
      teamId: "COMPANY001",
      personalTeam: false,
    },
  };

  test("--framework ios creates the Apple starter with the Apple answers", async () => {
    const starter = spyOn(appleStarter, "promptAppleStarter").mockResolvedValue(APPLE_RESULT);
    spies.push(starter);

    const result = await promptAndBootstrap("/tmp", IOS, {
      skipConfirm: true,
      nameOverride: "MyApp",
      apple: { platform: "macos", bundleId: "com.example.MyApp", teamId: "COMPANY001", flags: [] },
    });

    expect(result).toBe(APPLE_RESULT);
    expect(starter).toHaveBeenCalledWith("/tmp", "macos", {
      skipConfirm: true,
      name: "MyApp",
      bundleId: "com.example.MyApp",
      teamId: "COMPANY001",
      signInWithApple: undefined,
    });
  });

  // Swift names start uppercase, which the web starters' name check rejects.
  test("--name follows the Swift rules for an Apple starter", async () => {
    spies.push(spyOn(appleStarter, "promptAppleStarter").mockResolvedValue(APPLE_RESULT));

    await expect(
      promptAndBootstrap("/tmp", IOS, { skipConfirm: true, nameOverride: "MyApp" }),
    ).resolves.toBe(APPLE_RESULT);
  });

  test.each([
    [true, ["iOS (SwiftUI)", "macOS (SwiftUI)"]],
    [false, []],
  ] as const)("with Xcode %p, the framework list adds %p", async (xcode, added) => {
    spies.push(spyOn(coordinator, "canSetUpXcode").mockReturnValue(xcode));
    let names: string[] = [];
    spies.push(
      spyOn(listage, "search").mockImplementation(async (config) => {
        const choices = await config.source(undefined, { signal: new AbortController().signal });
        names = choices.map((choice) => (choice as { name: string }).name);
        throw new Error("stop");
      }),
    );

    await expect(
      promptAndBootstrap("/tmp", undefined, { skipConfirm: false, implicitBootstrap: true }),
    ).rejects.toThrow("stop");

    expect(names).toEqual([...BOOTSTRAP_REGISTRY.map((entry) => entry.label), ...added]);
  });

  test("choosing iOS in the list creates the Apple starter", async () => {
    spies.push(spyOn(coordinator, "canSetUpXcode").mockReturnValue(true));
    spies.push(spyOn(listage, "search").mockResolvedValue("ios"));
    const starter = spyOn(appleStarter, "promptAppleStarter").mockResolvedValue(APPLE_RESULT);
    spies.push(starter);

    await promptAndBootstrap("/tmp", undefined, { skipConfirm: false, implicitBootstrap: true });

    expect(starter).toHaveBeenCalledWith(
      "/tmp",
      "ios",
      expect.objectContaining({ skipConfirm: false }),
    );
  });

  test("Apple flags stop a web starter before anything is generated", async () => {
    spies.push(spyOn(coordinator, "canSetUpXcode").mockReturnValue(true));
    spies.push(spyOn(listage, "search").mockResolvedValue("next"));
    const spawn = spyOn(Bun, "spawn");
    spies.push(spawn);

    await expect(
      promptAndBootstrap("/tmp", undefined, {
        skipConfirm: false,
        implicitBootstrap: true,
        apple: { flags: ["--bundle-id"] },
      }),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("--bundle-id applies only to iOS and macOS apps"),
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("accountless flags with a native Apple starter", () => {
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  // iOS and macOS have no accountless setup, so these are rejected before any file is written.
  test.each(["--accountless", "--template", "--fresh"])(
    "%s stops before the project is created",
    async (flag) => {
      const tmp = mkdtempSync(join(tmpdir(), "clerk-bootstrap-"));
      const starter = spyOn(appleStarter, "promptAppleStarter");
      spies.push(starter);
      try {
        await expect(
          promptAndBootstrap(tmp, { name: "iOS (Swift)", dep: "ios" } as never, {
            skipConfirm: true,
            nameOverride: "MyApp",
            accountlessFlags: [flag],
          }),
        ).rejects.toMatchObject({
          exitCode: 2,
          message: expect.stringContaining(`${flag} applies only to accountless web setup`),
        });
        expect(starter).not.toHaveBeenCalled();
        expect(readdirSync(tmp)).toEqual([]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
