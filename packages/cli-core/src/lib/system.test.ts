import { describe, test, expect } from "bun:test";
import { createFakeSystem } from "./system.fake.ts";

describe("FakeSystem.which", () => {
  test("returns null for unregistered binary", () => {
    const system = createFakeSystem();
    expect(system.which("bunx")).toBeNull();
  });

  test("returns registered path", () => {
    const system = createFakeSystem({ binaries: { bunx: "/usr/bin/bunx" } });
    expect(system.which("bunx")).toBe("/usr/bin/bunx");
  });

  test("setBinary overrides after construction", () => {
    const system = createFakeSystem();
    system.setBinary("pnpm", "/opt/pnpm");
    expect(system.which("pnpm")).toBe("/opt/pnpm");
    system.setBinary("pnpm", null);
    expect(system.which("pnpm")).toBeNull();
  });

  test("records which calls in order", () => {
    const system = createFakeSystem({ binaries: { npm: "/usr/bin/npm" } });
    system.which("bunx");
    system.which("npm");
    expect(system.calls.which).toEqual(["bunx", "npm"]);
  });
});

describe("FakeSystem.spawnSync", () => {
  test("returns queued result", () => {
    const system = createFakeSystem();
    system.queueSpawnSync({ exitCode: 0, stdout: "ok", stderr: "" });
    const res = system.spawnSync(["yarn", "dlx", "--help"]);
    expect(res.exitCode).toBe(0);
  });

  test("throws if no result queued", () => {
    const system = createFakeSystem();
    expect(() => system.spawnSync(["yarn"])).toThrow(/no queued spawnSync/i);
  });

  test("records calls", () => {
    const system = createFakeSystem();
    system.queueSpawnSync({ exitCode: 0, stdout: "", stderr: "" });
    system.spawnSync(["yarn", "dlx", "--help"], { cwd: "/tmp" });
    expect(system.calls.spawnSync).toEqual([
      { cmd: ["yarn", "dlx", "--help"], opts: { cwd: "/tmp" } },
    ]);
  });
});

describe("FakeSystem.runInherit", () => {
  test("returns queued exit code", async () => {
    const system = createFakeSystem();
    system.queueRunInherit(0);
    await expect(system.runInherit(["echo", "ok"])).resolves.toBe(0);
  });

  test("queued throw surfaces", async () => {
    const system = createFakeSystem();
    system.queueRunInherit(new Error("ENOENT"));
    await expect(system.runInherit(["missing"])).rejects.toThrow("ENOENT");
  });

  test("throws if queue empty", async () => {
    const system = createFakeSystem();
    await expect(system.runInherit(["echo"])).rejects.toThrow(/no queued runInherit/i);
  });

  test("records calls", async () => {
    const system = createFakeSystem();
    system.queueRunInherit(0);
    await system.runInherit(["git", "status"], { cwd: "/repo" });
    expect(system.calls.runInherit).toEqual([{ cmd: ["git", "status"], opts: { cwd: "/repo" } }]);
  });
});

describe("FakeSystem.runCapture", () => {
  test("returns queued capture", async () => {
    const system = createFakeSystem();
    system.queueRunCapture({ exitCode: 0, stdout: " M file\n", stderr: "" });
    const res = await system.runCapture(["git", "status", "--porcelain"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(" M file\n");
  });

  test("records calls", async () => {
    const system = createFakeSystem();
    system.queueRunCapture({ exitCode: 0, stdout: "", stderr: "" });
    await system.runCapture(["git", "status"], { cwd: "/r" });
    expect(system.calls.runCapture).toEqual([{ cmd: ["git", "status"], opts: { cwd: "/r" } }]);
  });
});

describe("FakeSystem.spawn", () => {
  test("returns queued Subprocess-shaped result", async () => {
    const system = createFakeSystem();
    system.queueSpawn({ exitCode: 0 });
    const proc = system.spawn(["echo", "ok"]);
    await expect(proc.exited).resolves.toBe(0);
  });

  test("records calls", () => {
    const system = createFakeSystem();
    system.queueSpawn({ exitCode: 0 });
    system.spawn(["echo"], { cwd: "/tmp", stdout: "inherit", stderr: "inherit" });
    expect(system.calls.spawn.length).toBe(1);
    expect(system.calls.spawn[0]?.cmd).toEqual(["echo"]);
  });
});

describe("real createSystem", () => {
  test("which resolves a known binary", async () => {
    const { createSystem } = await import("./system.ts");
    const system = createSystem();
    expect(system.which("sh")).not.toBeNull();
  });

  test("runCapture captures echo output", async () => {
    const { createSystem } = await import("./system.ts");
    const system = createSystem();
    const res = await system.runCapture(["sh", "-c", "echo hi && echo err 1>&2; exit 0"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("hi");
    expect(res.stderr).toContain("err");
  });
});
