import { test, expect, describe, afterEach } from "bun:test";
import {
  RUNNERS,
  type Runner,
  detectAvailableRunners,
  preferredRunner,
  runnerCommand,
  runnerForPackageManager,
} from "./runners.ts";

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

describe("RUNNERS", () => {
  test("includes the four expected runner ids", () => {
    expect(RUNNERS.map((r) => r.id)).toEqual(["bunx", "npx", "pnpm", "yarn"]);
  });

  test("dlx-style runners have the dlx prefix arg", () => {
    const pnpm = RUNNERS.find((r) => r.id === "pnpm")!;
    const yarn = RUNNERS.find((r) => r.id === "yarn")!;
    expect(pnpm.prefixArgs).toEqual(["dlx"]);
    expect(yarn.prefixArgs).toEqual(["dlx"]);
  });

  test("bunx and npx have no prefix args", () => {
    const bunx = RUNNERS.find((r) => r.id === "bunx")!;
    const npx = RUNNERS.find((r) => r.id === "npx")!;
    expect(bunx.prefixArgs).toEqual([]);
    expect(npx.prefixArgs).toEqual([]);
  });
});

describe("runnerCommand", () => {
  const bunx = RUNNERS.find((r) => r.id === "bunx")!;
  const npx = RUNNERS.find((r) => r.id === "npx")!;
  const pnpm = RUNNERS.find((r) => r.id === "pnpm")!;
  const yarn = RUNNERS.find((r) => r.id === "yarn")!;

  test("prepends the runner binary for prefix-less runners", () => {
    expect(runnerCommand(bunx, ["skills", "add", "clerk/skills"])).toEqual([
      "bunx",
      "skills",
      "add",
      "clerk/skills",
    ]);
    expect(runnerCommand(npx, ["prettier", "--write", "x.ts"])).toEqual([
      "npx",
      "prettier",
      "--write",
      "x.ts",
    ]);
  });

  test("inserts dlx between binary and args for pnpm/yarn", () => {
    expect(runnerCommand(pnpm, ["prettier", "--write", "x.ts"])).toEqual([
      "pnpm",
      "dlx",
      "prettier",
      "--write",
      "x.ts",
    ]);
    expect(runnerCommand(yarn, ["skills", "add"])).toEqual(["yarn", "dlx", "skills", "add"]);
  });

  test("handles empty args", () => {
    expect(runnerCommand(bunx, [])).toEqual(["bunx"]);
    expect(runnerCommand(pnpm, [])).toEqual(["pnpm", "dlx"]);
  });
});

describe("preferredRunner", () => {
  const bunx = RUNNERS.find((r) => r.id === "bunx")!;
  const npx = RUNNERS.find((r) => r.id === "npx")!;
  const pnpm = RUNNERS.find((r) => r.id === "pnpm")!;
  const yarn = RUNNERS.find((r) => r.id === "yarn")!;

  test("returns undefined when no runners are available", () => {
    expect(preferredRunner("bun", [])).toBeUndefined();
    expect(preferredRunner(undefined, [])).toBeUndefined();
  });

  test("returns the runner matching the project's package manager", () => {
    const all = [bunx, npx, pnpm, yarn];
    expect(preferredRunner("bun", all)?.id).toBe("bunx");
    expect(preferredRunner("npm", all)?.id).toBe("npx");
    expect(preferredRunner("pnpm", all)?.id).toBe("pnpm");
    expect(preferredRunner("yarn", all)?.id).toBe("yarn");
  });

  test("falls back to first available when the preferred pm runner is missing", () => {
    expect(preferredRunner("bun", [npx, pnpm])?.id).toBe("npx");
    expect(preferredRunner("yarn", [pnpm])?.id).toBe("pnpm");
  });

  test("returns first available when no package manager is given", () => {
    expect(preferredRunner(undefined, [npx, pnpm, yarn])?.id).toBe("npx");
    expect(preferredRunner(undefined, [yarn])?.id).toBe("yarn");
  });

  test("preserves RUNNERS preference order in fallback", () => {
    expect(preferredRunner(undefined, RUNNERS)?.id).toBe("bunx");
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

  test("preserves RUNNERS order in the output", () => {
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
    const runner = preferredRunner("pnpm", available);
    expect(runner?.id).toBe("pnpm");

    const command = runnerCommand(runner as Runner, ["prettier", "--write", "src/x.ts"]);
    expect(command).toEqual(["pnpm", "dlx", "prettier", "--write", "src/x.ts"]);
  });
});
