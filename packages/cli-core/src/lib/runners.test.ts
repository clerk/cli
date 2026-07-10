import { test, expect, describe, afterEach } from "bun:test";
import {
  KNOWN_RUNNERS,
  detectAvailableRunners,
  preferredRunner,
  runnerCommand,
  runnerForPackageManager,
} from "./runners.ts";
import { isNonEmpty } from "./helpers/arrays.ts";

// Bun.which / Bun.spawnSync are native globals. We patch them directly the
// same way commands/auth/login.test.ts patches Bun.spawn — wrapped in
// try/catch because some runtimes mark globals as non-writable.
const origWhich = Bun.which;
const origSpawnSync = Bun.spawnSync;

function mockWhich(present: ReadonlySet<string>) {
  try {
    (Bun as unknown as { which: (bin: string) => string | null }).which = (bin) =>
      present.has(bin) ? `/usr/local/bin/${bin}` : null;
  } catch {
    // Bun.which may not be writable on some runtimes
  }
}

function restoreWhich() {
  try {
    (Bun as unknown as { which: typeof Bun.which }).which = origWhich;
  } catch {
    // Bun.which may not be writable on some runtimes
  }
}

/**
 * Stubs `Bun.spawnSync` for the `yarn dlx --help` probe in
 * `detectAvailableRunners`. `yarnDlxExitCode` controls what the probe sees:
 * 0 simulates Yarn Berry, non-zero simulates Yarn Classic.
 */
function mockSpawnSync(yarnDlxExitCode: number) {
  try {
    (Bun as unknown as { spawnSync: (cmd: string[]) => { exitCode: number } }).spawnSync = (
      cmd,
    ) => {
      if (cmd[0] === "yarn" && cmd[1] === "dlx") return { exitCode: yarnDlxExitCode };
      return { exitCode: 0 };
    };
  } catch {
    // Bun.spawnSync may not be writable on some runtimes
  }
}

function restoreSpawnSync() {
  try {
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = origSpawnSync;
  } catch {
    // Bun.spawnSync may not be writable on some runtimes
  }
}

describe("KNOWN_RUNNERS", () => {
  test("includes the four expected runner ids", () => {
    expect(KNOWN_RUNNERS.map((r) => r.id)).toEqual(["bunx", "npx", "pnpm", "yarn"]);
  });

  test("dlx-style runners have the dlx prefix arg", () => {
    const pnpm = KNOWN_RUNNERS.find((r) => r.id === "pnpm")!;
    const yarn = KNOWN_RUNNERS.find((r) => r.id === "yarn")!;
    expect(pnpm.prefixArgs).toEqual(["dlx"]);
    expect(yarn.prefixArgs).toEqual(["dlx"]);
  });

  test("bunx and npx have no prefix args", () => {
    const bunx = KNOWN_RUNNERS.find((r) => r.id === "bunx")!;
    const npx = KNOWN_RUNNERS.find((r) => r.id === "npx")!;
    expect(bunx.prefixArgs).toEqual([]);
    expect(npx.prefixArgs).toEqual([]);
  });
});

describe("runnerCommand", () => {
  const bunx = KNOWN_RUNNERS.find((r) => r.id === "bunx")!;
  const npx = KNOWN_RUNNERS.find((r) => r.id === "npx")!;
  const pnpm = KNOWN_RUNNERS.find((r) => r.id === "pnpm")!;
  const yarn = KNOWN_RUNNERS.find((r) => r.id === "yarn")!;

  // bunx/npx resolve a project-local node_modules/.bin/<bin> before the
  // registry. Only an explicit version spec (`@latest`) forces a registry
  // fetch; a bare `--package <pkg>` still runs the local bin.
  test("pins <pkg>@latest for prefix-less runners (bunx/npx)", () => {
    expect(runnerCommand(bunx, "skills", ["skills", "add", "clerk/skills"])).toEqual([
      "bunx",
      "--package",
      "skills@latest",
      "--",
      "skills",
      "add",
      "clerk/skills",
    ]);
    expect(runnerCommand(npx, "prettier", ["prettier", "--write", "x.ts"])).toEqual([
      "npx",
      "--package",
      "prettier@latest",
      "--",
      "prettier",
      "--write",
      "x.ts",
    ]);
  });

  test("pins by package name even when the bin name differs (biome)", () => {
    expect(runnerCommand(bunx, "@biomejs/biome", ["biome", "format", "x.ts"])).toEqual([
      "bunx",
      "--package",
      "@biomejs/biome@latest",
      "--",
      "biome",
      "format",
      "x.ts",
    ]);
  });

  test("uses dlx <pkg>@latest for pnpm/yarn, dropping the redundant bin name", () => {
    expect(runnerCommand(pnpm, "prettier", ["prettier", "--write", "x.ts"])).toEqual([
      "pnpm",
      "dlx",
      "prettier@latest",
      "--write",
      "x.ts",
    ]);
    expect(runnerCommand(yarn, "@biomejs/biome", ["biome", "format", "x.ts"])).toEqual([
      "yarn",
      "dlx",
      "@biomejs/biome@latest",
      "format",
      "x.ts",
    ]);
  });
});

describe("preferredRunner", () => {
  const bunx = KNOWN_RUNNERS.find((r) => r.id === "bunx")!;
  const npx = KNOWN_RUNNERS.find((r) => r.id === "npx")!;
  const pnpm = KNOWN_RUNNERS.find((r) => r.id === "pnpm")!;
  const yarn = KNOWN_RUNNERS.find((r) => r.id === "yarn")!;

  // preferredRunner now requires a NonEmptyArray<Runner>, so the empty-array
  // case is unrepresentable in the type system and doesn't need a runtime test.

  test("returns the runner matching the project's package manager", () => {
    const all = [bunx, npx, pnpm, yarn] as const;
    expect(preferredRunner("bun", all).id).toBe("bunx");
    expect(preferredRunner("npm", all).id).toBe("npx");
    expect(preferredRunner("pnpm", all).id).toBe("pnpm");
    expect(preferredRunner("yarn", all).id).toBe("yarn");
  });

  test("falls back to first available when the preferred pm runner is missing", () => {
    // Project is bun but only npx is on PATH → fall back to npx (first
    // available, which RUNNERS orders as bunx > npx > pnpm > yarn).
    expect(preferredRunner("bun", [npx, pnpm] as const).id).toBe("npx");
    // Project is yarn but only pnpm is on PATH → fall back to pnpm.
    expect(preferredRunner("yarn", [pnpm] as const).id).toBe("pnpm");
  });

  test("returns first available when no package manager is given", () => {
    expect(preferredRunner(undefined, [npx, pnpm, yarn] as const).id).toBe("npx");
    expect(preferredRunner(undefined, [yarn] as const).id).toBe("yarn");
  });

  test("preserves KNOWN_RUNNERS preference order in fallback", () => {
    // Even with all four available, no pm hint → bunx wins (it's first in KNOWN_RUNNERS).
    // KNOWN_RUNNERS isn't typed as NonEmptyArray, so we narrow via isNonEmpty.
    if (!isNonEmpty(KNOWN_RUNNERS)) throw new Error("unreachable");
    expect(preferredRunner(undefined, KNOWN_RUNNERS).id).toBe("bunx");
  });
});

describe("runnerForPackageManager", () => {
  test("returns the matching runner for each package manager", () => {
    expect(runnerForPackageManager("bun").id).toBe("bunx");
    expect(runnerForPackageManager("npm").id).toBe("npx");
    expect(runnerForPackageManager("pnpm").id).toBe("pnpm");
    expect(runnerForPackageManager("yarn").id).toBe("yarn");
  });

  test("falls back to the first runner when packageManager is undefined", () => {
    expect(runnerForPackageManager(undefined).id).toBe("bunx");
  });

  test("does not consult PATH (returns a Runner regardless of installed binaries)", () => {
    mockWhich(new Set());
    expect(runnerForPackageManager("pnpm").id).toBe("pnpm");
    restoreWhich();
  });
});

describe("detectAvailableRunners", () => {
  afterEach(() => {
    restoreWhich();
    restoreSpawnSync();
  });

  test("returns empty when no runner binaries are on PATH", () => {
    mockWhich(new Set());
    expect(detectAvailableRunners()).toEqual([]);
  });

  test("returns only the runners whose binaries Bun.which finds", () => {
    mockWhich(new Set(["bunx", "pnpm"]));
    const result = detectAvailableRunners();
    expect(result.map((r) => r.id)).toEqual(["bunx", "pnpm"]);
  });

  test("preserves KNOWN_RUNNERS order in the output", () => {
    // Even though we list yarn first in the set, the result should still
    // be in KNOWN_RUNNERS preference order (bunx > npx > pnpm > yarn).
    mockWhich(new Set(["yarn", "bunx", "npx"]));
    mockSpawnSync(0);
    const result = detectAvailableRunners();
    expect(result.map((r) => r.id)).toEqual(["bunx", "npx", "yarn"]);
  });

  test("returns all four when every binary is present and yarn supports dlx", () => {
    mockWhich(new Set(["bunx", "npx", "pnpm", "yarn"]));
    mockSpawnSync(0);
    const result = detectAvailableRunners();
    expect(result).toHaveLength(4);
    expect(result.map((r) => r.id)).toEqual(["bunx", "npx", "pnpm", "yarn"]);
  });

  test("excludes yarn when `yarn dlx --help` exits non-zero (Yarn Classic)", () => {
    mockWhich(new Set(["bunx", "npx", "pnpm", "yarn"]));
    mockSpawnSync(1);
    const result = detectAvailableRunners();
    expect(result.map((r) => r.id)).toEqual(["bunx", "npx", "pnpm"]);
  });

  test("includes yarn when `yarn dlx --help` exits 0 (Yarn Berry)", () => {
    mockWhich(new Set(["yarn"]));
    mockSpawnSync(0);
    const result = detectAvailableRunners();
    expect(result.map((r) => r.id)).toEqual(["yarn"]);
  });

  test("integrates cleanly with preferredRunner + runnerCommand", () => {
    mockWhich(new Set(["npx", "pnpm"]));
    const available = detectAvailableRunners();
    if (!isNonEmpty(available)) throw new Error("expected at least one runner");
    // After the isNonEmpty narrowing, preferredRunner returns Runner (no
    // undefined) and `runner` doesn't need a cast.
    const runner = preferredRunner("pnpm", available);
    expect(runner.id).toBe("pnpm");

    const command = runnerCommand(runner, "prettier", ["prettier", "--write", "src/x.ts"]);
    expect(command).toEqual(["pnpm", "dlx", "prettier@latest", "--write", "src/x.ts"]);
  });
});
