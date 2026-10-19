/**
 * `clerk env pull` must only ever write keys into a file the claim check reads.
 *
 * The claim check (`lib/autoclaim.ts`) compares every key in
 * `ENV_FILE_CANDIDATES`; a write into any other file could replace a key it
 * never compared. The type of `defaultTargetFile` already confines its answer
 * to that list. This test covers the folder layouts modeled here: which files
 * exist, and which of `.env` and `.env.local` already holds Clerk keys, which
 * `env pull`'s third rule depends on. It can't anticipate a new rule's files.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_FILE_CANDIDATES, type PreferredEnvFile } from "../../lib/dotenv.ts";
import { FRAMEWORK_MAP, NATIVE_FRAMEWORK_MAP } from "../../lib/framework.ts";
import { defaultTargetFile } from "./pull.ts";

// Every framework's preferred file, plus `env pull`'s own default.
const PREFERRED_FILES: PreferredEnvFile[] = [
  ...new Set<PreferredEnvFile>([
    ...[...FRAMEWORK_MAP, ...NATIVE_FRAMEWORK_MAP].map((fw) => fw.envFile),
    ".env.local",
  ]),
];

// Every subset of the candidate files, as the files that exist.
const EXISTING_FILE_SETS = Array.from({ length: 2 ** ENV_FILE_CANDIDATES.length }, (_, mask) =>
  ENV_FILE_CANDIDATES.filter((_, bit) => mask & (1 << bit)),
);

const CASES = PREFERRED_FILES.flatMap((preferred) =>
  EXISTING_FILE_SETS.flatMap((existing) =>
    [undefined, ...existing.filter((file) => file === ".env" || file === ".env.local")].map(
      (keysIn) => ({
        preferred,
        existing,
        keysIn,
        label: `preferred ${preferred}; files [${existing.join(", ")}]; Clerk keys in ${keysIn ?? "none"}`,
      }),
    ),
  ),
);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clerk-target-file-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test.each(CASES)(
  "writes to a file the claim check reads: $label",
  async ({ preferred, existing, keysIn }) => {
    await Promise.all(
      existing.map((file) =>
        Bun.write(join(dir, file), file === keysIn ? "CLERK_SECRET_KEY=sk_test_x\n" : "OTHER=1\n"),
      ),
    );

    expect(ENV_FILE_CANDIDATES).toContain(await defaultTargetFile(dir, preferred));
  },
);
