import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupError } from "../android/types.ts";
import { fileOperations } from "./files.ts";

const { gitStatus, gitTracked } = fileOperations(setupError);

const roots: string[] = [];
const inheritedGitEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const name of Object.keys(process.env).filter((key) => key.startsWith("GIT_"))) {
    inheritedGitEnv[name] = process.env[name];
    delete process.env[name];
  }
});
afterAll(() => Object.assign(process.env, inheritedGitEnv));
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repoWithTrackedFile(tracked: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clerk-native-files-"));
  roots.push(root);
  await mkdir(join(root, tracked, ".."), { recursive: true });
  await writeFile(join(root, tracked), "tracked\n");
  await Bun.$`git init -q && git add -A && git -c core.hooksPath=/dev/null -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm init`
    .cwd(root)
    .quiet();
  return root;
}

describe("native file git checks", () => {
  test("read a path with glob characters literally, not as a pattern matching another file", async () => {
    const root = await repoWithTrackedFile("appA/src/clerk.xml");
    const untracked = "app[A]/src/clerk.xml";
    await mkdir(join(root, "app[A]/src"), { recursive: true });
    await writeFile(join(root, untracked), "untracked\n");

    expect(await gitTracked(root, untracked)).toBe(false);
    expect(await gitStatus(root, untracked)).toBe("dirty");
    expect(await gitTracked(root, "appA/src/clerk.xml")).toBe(true);
    expect(await gitStatus(root, "appA/src/clerk.xml")).toBe("clean");
  });

  test("ignore an inherited GIT_DIR and GIT_WORK_TREE that point at another repository", async () => {
    // A hook of `other` running the CLI inherits variables that pin Git to `other`, where the
    // same path is clean and tracked; the project's own copy is edited.
    const other = await repoWithTrackedFile("app/src/clerk.xml");
    const root = await repoWithTrackedFile("app/src/clerk.xml");
    await writeFile(join(root, "app/src/clerk.xml"), "edited\n");
    process.env.GIT_DIR = join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    try {
      expect(await gitStatus(root, "app/src/clerk.xml")).toBe("dirty");
      expect(await gitTracked(root, "app/src/clerk.xml")).toBe(true);
      await writeFile(join(root, "app/src/untracked.xml"), "new\n");
      expect(await gitTracked(root, "app/src/untracked.xml")).toBe(false);
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
    }
  });
});
