import { test, expect, describe } from "bun:test";

const INSTALL_SCRIPT = "./install.sh";

async function runInstall(...args: string[]) {
  const proc = Bun.spawn(["bash", INSTALL_SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("install.sh flag validation", () => {
  test("--version without a value exits with error", async () => {
    const { stderr, exitCode } = await runInstall("--version");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--version requires a value");
  });

  test("--version followed by another flag exits with error", async () => {
    const { stderr, exitCode } = await runInstall("--version", "--canary");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--version requires a value");
  });

  test("--install-dir without a value exits with error", async () => {
    const { stderr, exitCode } = await runInstall("--install-dir");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--install-dir requires a value");
  });

  test("--install-dir followed by another flag exits with error", async () => {
    const { stderr, exitCode } = await runInstall("--install-dir", "--local");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--install-dir requires a value");
  });

  test("--artifacts-dir without a value exits with error", async () => {
    const { stderr, exitCode } = await runInstall("--artifacts-dir");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--artifacts-dir requires a value");
  });

  test("--artifacts-dir followed by another flag exits with error", async () => {
    const { stderr, exitCode } = await runInstall("--artifacts-dir", "--canary");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--artifacts-dir requires a value");
  });
});
