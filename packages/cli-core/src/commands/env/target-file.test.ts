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

// Nuxt loads only `.env`, and the CLI reads a Nuxt folder's keys from there, so
// a write anywhere else would be read by neither.
test.each([
  { label: "an existing .env.development.local", existing: [".env.development.local"] },
  {
    label: "an existing .env.development.local and .env",
    existing: [".env.development.local", ".env"],
  },
  { label: "Clerk keys only in .env.local", existing: [".env.local"], keysIn: ".env.local" },
])("Nuxt, $label: writes .env", async ({ existing, keysIn }) => {
  await Bun.write(join(dir, "package.json"), JSON.stringify({ dependencies: { nuxt: "3.0.0" } }));
  await Promise.all(
    existing.map((file) =>
      Bun.write(join(dir, file), file === keysIn ? "CLERK_SECRET_KEY=sk_test_x\n" : "OTHER=1\n"),
    ),
  );

  expect(await defaultTargetFile(dir, ".env")).toBe(".env");
});

// Next.js loads `.env.development.local` first in development.
test("Next.js, an existing .env.development.local: writes it", async () => {
  await Bun.write(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));
  await Bun.write(join(dir, ".env.development.local"), "OTHER=1\n");

  expect(await defaultTargetFile(dir, ".env.local")).toBe(".env.development.local");
});

// A key written below the file that supplies the app's key now would keep
// losing to the old one, for the app and for the CLI's reader.
test.each([
  {
    label: "Astro, an old publishable key in .env.local beside an existing .env",
    dep: "astro",
    preferred: ".env" as const,
    files: { ".env": "OTHER=1\n", ".env.local": "PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_old\n" },
    writes: ".env.local",
  },
  {
    label: "Vite, an old publishable key in .env.development beside an existing .env.local",
    dep: "vite",
    preferred: ".env.local" as const,
    files: {
      ".env.local": "OTHER=1\n",
      ".env.development": "VITE_CLERK_PUBLISHABLE_KEY=pk_test_old\n",
    },
    writes: ".env.development",
  },
  {
    label: "Vite, an old secret key in .env.development and none in .env.local",
    dep: "vite",
    preferred: ".env.local" as const,
    files: { ".env.local": "OTHER=1\n", ".env.development": "CLERK_SECRET_KEY=sk_test_old\n" },
    writes: ".env.development",
  },
])("$label: writes $writes", async ({ dep, preferred, files, writes }) => {
  await Bun.write(join(dir, "package.json"), JSON.stringify({ dependencies: { [dep]: "1.0.0" } }));
  await Promise.all(Object.entries(files).map(([file, text]) => Bun.write(join(dir, file), text)));

  expect(await defaultTargetFile(dir, preferred)).toBe(writes);
});
