import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIOSSourceSnapshot } from "./source-snapshot.ts";

const directories: string[] = [];
const restores: Array<() => void> = [];
const open = fs.open;

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "clerk-source-snapshot-"));
  directories.push(root);
  const path = join(root, "App.swift");
  await fs.writeFile(path, "\uFEFFimport SwiftUI\r\n", { mode: 0o640 });
  return { root, path };
}

afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore();
  await Promise.all(
    directories.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("Swift source snapshots", () => {
  test("preserves bytes, mode and identity from the file being read", async () => {
    const { root, path } = await fixture();
    const info = await fs.stat(path);
    const snapshot = await readIOSSourceSnapshot(root, "App.swift");
    expect(snapshot?.source).toBe("\uFEFFimport SwiftUI\r\n");
    expect(snapshot?.bytes).toEqual(new Uint8Array(await fs.readFile(path)));
    expect(snapshot).toMatchObject({ mode: 0o640, device: info.dev, inode: info.ino });
  });

  test.each(["missing", "directory", "symlink", "too-large", "invalid-utf8", "nul"])(
    "rejects a %s source",
    async (kind) => {
      const { root, path } = await fixture();
      await fs.rm(path);
      if (kind === "directory") await fs.mkdir(path);
      if (kind === "symlink") {
        await fs.writeFile(join(root, "Actual.swift"), "import SwiftUI\n");
        await fs.symlink("Actual.swift", path);
      }
      if (kind === "too-large") await fs.writeFile(path, "x".repeat(1_000_001));
      if (kind === "invalid-utf8") await fs.writeFile(path, new Uint8Array([0xff]));
      if (kind === "nul") await fs.writeFile(path, "import SwiftUI\0");
      expect(await readIOSSourceSnapshot(root, "App.swift")).toBeUndefined();
    },
  );

  test("keeps the opened file's bytes and identity when its path is replaced", async () => {
    const { root, path } = await fixture();
    const info = await fs.stat(path);
    let replaced = false;
    const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === path && !replaced) {
        replaced = true;
        await fs.rename(path, join(root, "Original.swift"));
        await fs.writeFile(path, "replacement", { mode: 0o600 });
      }
      return handle;
    });
    restores.push(() => openSpy.mockRestore());
    const snapshot = await readIOSSourceSnapshot(root, "App.swift");
    expect(replaced).toBe(true);
    expect(snapshot).toMatchObject({
      source: "\uFEFFimport SwiftUI\r\n",
      mode: 0o640,
      device: info.dev,
      inode: info.ino,
    });
    expect((await fs.stat(path)).ino).not.toBe(snapshot?.inode);
  });

  test("enforces the size bound even when a file grows after stat", async () => {
    const { root, path } = await fixture();
    let grew = false;
    const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === path) {
        const stat = handle.stat.bind(handle);
        const statSpy = spyOn(handle, "stat").mockImplementationOnce((async () => {
          const info = await stat();
          await fs.appendFile(path, "x".repeat(1_000_001));
          grew = true;
          return info;
        }) as typeof handle.stat);
        restores.push(() => statSpy.mockRestore());
      }
      return handle;
    });
    restores.push(() => openSpy.mockRestore());
    expect(await readIOSSourceSnapshot(root, "App.swift")).toBeUndefined();
    expect(grew).toBe(true);
  });
});
