import { test, expect, describe, spyOn, afterAll } from "bun:test";
import { BOOTSTRAP_REGISTRY } from "./bootstrap-registry.ts";
import { resolvePackageManager } from "./bootstrap.ts";

function entryFor(dep: string) {
  const entry = BOOTSTRAP_REGISTRY.find((e) => e.dep === dep);
  if (!entry) throw new Error(`No bootstrap entry for dep: ${dep}`);
  return entry;
}

describe("BOOTSTRAP_REGISTRY", () => {
  const packageManagers = ["npm", "yarn", "pnpm", "bun"] as const;

  test("contains all 8 supported frameworks", () => {
    expect(BOOTSTRAP_REGISTRY).toHaveLength(8);
    const deps = BOOTSTRAP_REGISTRY.map((e) => e.dep);
    expect(deps).toContain("next");
    expect(deps).toContain("react");
    expect(deps).toContain("vue");
    expect(deps).toContain("react-router");
    expect(deps).toContain("astro");
    expect(deps).toContain("nuxt");
    expect(deps).toContain("@tanstack/react-start");
    expect(deps).toContain("vite");
  });

  test("each entry produces a non-empty string[] for all package managers", () => {
    for (const entry of BOOTSTRAP_REGISTRY) {
      for (const pm of packageManagers) {
        const cmd = entry.buildCommand(pm, "test-app");
        expect(cmd.length).toBeGreaterThan(0);
        expect(cmd.every((arg) => typeof arg === "string")).toBe(true);
      }
    }
  });

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
