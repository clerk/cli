import { afterEach, describe, expect, test } from "bun:test";
import { openBrowser } from "./open.ts";

const origWhich = Bun.which;
const origSpawn = Bun.spawn;
const origPlatform = process.platform;

const bunOverrides = Bun as unknown as {
  which: (bin: string) => string | null;
  spawn: (cmd: string[], opts?: unknown) => { exited: Promise<number> };
};

afterEach(() => {
  bunOverrides.which = origWhich as typeof bunOverrides.which;
  bunOverrides.spawn = origSpawn as typeof bunOverrides.spawn;
  Object.defineProperty(process, "platform", { value: origPlatform, writable: true });
});

describe("openBrowser", () => {
  test("win32: quotes URL so ampersands are not treated as cmd.exe separators", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });

    let capturedCmd: string[] | undefined;
    bunOverrides.spawn = (cmd: string[], _opts?: unknown) => {
      capturedCmd = cmd;
      return { exited: Promise.resolve(0) };
    };

    const url = "https://example.com/oauth?client_id=abc&response_type=code&state=xyz";
    const result = await openBrowser(url);

    expect(result.ok).toBe(true);
    expect(capturedCmd).toBeDefined();
    // cmd.exe /c start "" "<url>" — the URL arg must be wrapped in quotes
    expect(capturedCmd![0]).toBe("cmd.exe");
    expect(capturedCmd![1]).toBe("/c");
    expect(capturedCmd![2]).toBe("start");
    expect(capturedCmd![3]).toBe("");
    expect(capturedCmd![4]).toBe(`"${url}"`);
  });

  test("non-win32: passes URL without extra quoting", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });

    bunOverrides.which = (bin: string) => (bin === "xdg-open" ? "/usr/bin/xdg-open" : null);

    let capturedCmd: string[] | undefined;
    bunOverrides.spawn = (cmd: string[], _opts?: unknown) => {
      capturedCmd = cmd;
      return { exited: Promise.resolve(0) };
    };

    const url = "https://example.com/oauth?client_id=abc&response_type=code&state=xyz";
    const result = await openBrowser(url);

    expect(result.ok).toBe(true);
    expect(capturedCmd).toEqual(["xdg-open", url]);
  });
});
