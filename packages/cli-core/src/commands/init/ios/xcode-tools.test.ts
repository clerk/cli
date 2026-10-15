import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compatibleXcode } from "./xcode-tools.ts";

const path = process.env.PATH;
const dirs: string[] = [];
afterEach(async () => {
  process.env.PATH = path;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("an Xcode that fails for its own reason is left to report it", async () => {
  // Like an Xcode whose license hasn't been accepted: every xcodebuild command exits 69.
  const dir = await mkdtemp(join(tmpdir(), "clerk-xcodebuild-"));
  dirs.push(dir);
  const fake = join(dir, "xcodebuild");
  await writeFile(
    fake,
    "#!/bin/sh\necho 'You have not agreed to the Xcode license agreements.' >&2\nexit 69\n",
  );
  await chmod(fake, 0o755);
  process.env.PATH = `${dir}:${path}`;

  // No substitute Xcode: the real command runs and shows xcodebuild's own message.
  expect(await compatibleXcode(1)).toBeUndefined();
});
