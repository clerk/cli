import { describe, expect, test } from "bun:test";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { findClientBinary, runClientCli, toSpawnArgv } from "./cli-exec.ts";

useCaptureLog();

// Spawn Bun itself (`process.execPath`) so the tests exercise real subprocesses
// without depending on any client CLI being installed.
const BUN = process.execPath;

describe("runClientCli", () => {
  test("captures exit code, stdout, and stderr", async () => {
    const result = await runClientCli([
      BUN,
      "-e",
      'console.log("to-stdout"); console.error("to-stderr"); process.exit(3);',
    ]);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("to-stdout");
    expect(result.stderr).toContain("to-stderr");
  });

  test("returns exit 0 for a successful command", async () => {
    const result = await runClientCli([BUN, "-e", "process.exit(0);"]);
    expect(result.exitCode).toBe(0);
  });

  test("feeds provided stdin to the child, then EOF", async () => {
    // Hermes' `mcp add` ends in an interactive y/N prompt and cancels on bare
    // EOF — clients like it get their answers piped in instead.
    const result = await runClientCli(
      [
        BUN,
        "-e",
        'let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => { console.log(`got:${d.trim()}`); process.exit(0); });',
      ],
      { stdin: "y\n" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("got:y");
  });

  test("closes stdin so a CLI waiting for input sees EOF instead of blocking", async () => {
    // The child exits with a marker code only when stdin reaches EOF. If stdin
    // were an open pipe, this would hang until the timeout instead.
    const result = await runClientCli([
      BUN,
      "-e",
      'process.stdin.resume(); process.stdin.on("end", () => process.exit(7));',
    ]);
    expect(result.exitCode).toBe(7);
  });

  test("kills the process and rejects when the timeout elapses", async () => {
    await expect(
      runClientCli([BUN, "-e", "setTimeout(() => {}, 30_000);"], { timeoutMs: 250 }),
    ).rejects.toMatchObject({
      code: "mcp_client_cli_failed",
      docsUrl: expect.stringContaining("https://clerk.com/docs/guides/ai/mcp/clerk-mcp-server"),
    });
  });

  test("names the command in the timeout error", async () => {
    await expect(
      runClientCli([BUN, "-e", "setTimeout(() => {}, 30_000);"], { timeoutMs: 250 }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("toSpawnArgv", () => {
  // npm-installed client CLIs resolve to `.cmd`/`.bat` shims on Windows, which
  // are cmd.exe scripts, not executables — they must be launched through
  // `cmd.exe /c` (Node's child_process has the same constraint).
  test.each([
    ["C:\\Users\\me\\AppData\\Roaming\\npm\\claude.CMD", "win32"],
    ["C:\\nvm\\gemini.bat", "win32"],
  ] as const)("wraps %s in cmd.exe /c on win32", (bin, platform) => {
    expect(toSpawnArgv([bin, "mcp", "add"], platform)).toEqual([
      "cmd.exe",
      "/c",
      bin,
      "mcp",
      "add",
    ]);
  });

  test("leaves a win32 .exe untouched", () => {
    expect(toSpawnArgv(["C:\\bin\\claude.exe", "mcp"], "win32")).toEqual([
      "C:\\bin\\claude.exe",
      "mcp",
    ]);
  });

  test("leaves POSIX binaries untouched even with a .cmd-looking name", () => {
    expect(toSpawnArgv(["/usr/local/bin/claude", "mcp"], "darwin")).toEqual([
      "/usr/local/bin/claude",
      "mcp",
    ]);
  });
});

describe("findClientBinary", () => {
  test("resolves a binary that exists on PATH", () => {
    // `bun` is guaranteed on PATH in this repo — the test suite runs under it.
    expect(findClientBinary("bun")).toBeTruthy();
  });

  test("returns null for a binary that does not exist", () => {
    expect(findClientBinary("definitely-not-a-real-client-cli-xyz")).toBeNull();
  });
});
