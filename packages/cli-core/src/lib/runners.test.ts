import { describe, test, expect } from "bun:test";
import { createRunners, KNOWN_RUNNERS, runnerCommand, runnerForPackageManager } from "./runners.ts";
import { createFakeSystem } from "./system.fake.ts";

describe("createRunners().detectAvailable", () => {
  test("returns only runners whose binaries resolve on PATH", () => {
    const system = createFakeSystem({
      binaries: { bunx: "/u/bunx", npm: null, pnpm: "/u/pnpm", yarn: null },
    });
    const runners = createRunners(system);
    const ids = runners.detectAvailable().map((r) => r.id);
    expect(ids).toEqual(["bunx", "pnpm"]);
  });

  test("yarn requires a successful `yarn dlx --help` probe", () => {
    const system = createFakeSystem({ binaries: { yarn: "/u/yarn" } });
    system.queueSpawnSync({ exitCode: 0, stdout: "", stderr: "" });
    const runners = createRunners(system);
    expect(runners.detectAvailable().map((r) => r.id)).toEqual(["yarn"]);
    expect(system.calls.spawnSync[0]?.cmd).toEqual(["yarn", "dlx", "--help"]);
  });

  test("yarn is excluded when `yarn dlx --help` exits non-zero (Yarn Classic)", () => {
    const system = createFakeSystem({ binaries: { yarn: "/u/yarn" } });
    system.queueSpawnSync({ exitCode: 1, stdout: "", stderr: "Command not found" });
    const runners = createRunners(system);
    expect(runners.detectAvailable()).toEqual([]);
  });

  test("yarn is excluded when the dlx probe throws", () => {
    const system = createFakeSystem({ binaries: { yarn: "/u/yarn" } });
    // No queued spawnSync result -> FakeSystem throws, runners should swallow.
    const runners = createRunners(system);
    expect(runners.detectAvailable()).toEqual([]);
  });

  test("returns [] when no runners resolve", () => {
    const system = createFakeSystem();
    const runners = createRunners(system);
    expect(runners.detectAvailable()).toEqual([]);
  });
});

describe("createRunners().preferred", () => {
  test("picks the pm-matching runner when it's available", () => {
    const system = createFakeSystem({ binaries: { bunx: "/u/bunx", npx: "/u/npx" } });
    const runners = createRunners(system);
    const available = runners.detectAvailable();
    expect(runners.preferred("npm", available)?.id).toBe("npx");
  });

  test("falls back to the first available when pm-matching runner is missing", () => {
    const system = createFakeSystem({ binaries: { npx: "/u/npx" } });
    const runners = createRunners(system);
    const available = runners.detectAvailable();
    expect(runners.preferred("bun", available)?.id).toBe("npx");
  });

  test("returns undefined when no runners are available", () => {
    const system = createFakeSystem();
    const runners = createRunners(system);
    expect(runners.preferred("npm", [])).toBeUndefined();
  });
});

describe("runnerForPackageManager (pure)", () => {
  test("maps pm to the matching known runner", () => {
    expect(runnerForPackageManager("bun").id).toBe("bunx");
    expect(runnerForPackageManager("npm").id).toBe("npx");
    expect(runnerForPackageManager("pnpm").id).toBe("pnpm");
    expect(runnerForPackageManager("yarn").id).toBe("yarn");
  });

  test("falls back to KNOWN_RUNNERS[0] when pm is undefined", () => {
    expect(runnerForPackageManager(undefined)).toBe(KNOWN_RUNNERS[0]!);
  });
});

describe("runnerCommand (pure)", () => {
  test("prepends bare runners without prefix args", () => {
    const bunx = KNOWN_RUNNERS.find((r) => r.id === "bunx")!;
    expect(runnerCommand(bunx, ["skills", "add"])).toEqual(["bunx", "skills", "add"]);
  });

  test("prepends dlx prefix for pnpm/yarn", () => {
    const pnpm = KNOWN_RUNNERS.find((r) => r.id === "pnpm")!;
    expect(runnerCommand(pnpm, ["skills", "add"])).toEqual(["pnpm", "dlx", "skills", "add"]);
  });
});
