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

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_FILE_CANDIDATES, type PreferredEnvFile } from "../../lib/dotenv.ts";
import { FRAMEWORK_MAP, NATIVE_FRAMEWORK_MAP } from "../../lib/framework.ts";
import * as git from "../../lib/git.ts";
import * as localKeys from "../../lib/local-keys.ts";
import { defaultTargetFile, targetByFiles } from "./pull.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";

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

// A Clerk key in a file the framework loads before the target would keep
// beating the new one, so the target moves up to the highest-ranked `.local`
// file instead of into that file, which may be committed.
test.each([
  {
    label: "Vite, a publishable key in a committed .env.development, the secret key in .env.local",
    dep: "vite",
    preferred: ".env.local" as const,
    files: {
      ".env.development": "VITE_CLERK_PUBLISHABLE_KEY=pk_test_old\n",
      ".env.local": "CLERK_SECRET_KEY=sk_test_old\n",
    },
    writes: ".env.development.local",
  },
  {
    label: "Next.js, a publishable key in .env and an .env.local with no keys",
    dep: "next",
    preferred: ".env.local" as const,
    files: { ".env": "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_old\n", ".env.local": "OTHER=1\n" },
    writes: ".env.local",
  },
  {
    label: "Astro, an old publishable key in .env.local, ranked above an existing .env",
    dep: "astro",
    preferred: ".env" as const,
    files: { ".env": "OTHER=1\n", ".env.local": "PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_old\n" },
    writes: ".env.development.local",
  },
  {
    label: "Nuxt, which loads only .env, with an old key in .env",
    dep: "nuxt",
    preferred: ".env" as const,
    files: { ".env": "NUXT_CLERK_SECRET_KEY=sk_test_old\n" },
    writes: ".env",
  },
])("$label: writes $writes", async ({ dep, preferred, files, writes }) => {
  await Bun.write(join(dir, "package.json"), JSON.stringify({ dependencies: { [dep]: "1.0.0" } }));
  await Promise.all(Object.entries(files).map(([file, text]) => Bun.write(join(dir, file), text)));

  expect(await defaultTargetFile(dir, preferred)).toBe(writes);
});

// Every framework that loads a `.local` file, every layout of the candidate
// files, and a Clerk key in each of them in turn.
const LOADS_A_LOCAL_FILE = FRAMEWORK_MAP.filter((fw) =>
  fw.envLoadOrder?.some((file) => file.endsWith(".local")),
);
const LOCAL_CASES = LOADS_A_LOCAL_FILE.flatMap((fw) =>
  EXISTING_FILE_SETS.flatMap((existing) =>
    [undefined, ...existing].map((keysIn) => ({
      fw,
      existing,
      keysIn,
      label: `${fw.name}; files [${existing.join(", ")}]; a Clerk key in ${keysIn ?? "none"}`,
    })),
  ),
);

test.each(LOCAL_CASES)(
  "the stale-key redirect never picks a non-.local file: $label",
  async ({ fw, existing, keysIn }) => {
    await Bun.write(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { [fw.dep]: "1.0.0" } }),
    );
    await Promise.all(
      existing.map((file) =>
        Bun.write(join(dir, file), file === keysIn ? "CLERK_SECRET_KEY=sk_test_x\n" : "OTHER=1\n"),
      ),
    );

    const byFiles = await targetByFiles(dir, fw.envFile, fw.envLoadOrder);
    const target = await defaultTargetFile(dir, fw.envFile);
    if (target !== byFiles) expect(target).toEndWith(".local");
  },
);

// Any Clerk line in a file the framework loads before the target may still set
// a key there, so it redirects too: an empty value, a line the CLI can't
// parse, or a file it can't read at all.
describe("a Vite folder whose committed .env.development may still set a Clerk key", () => {
  const captured = useCaptureLog();

  beforeEach(async () => {
    await Bun.write(join(dir, "package.json"), JSON.stringify({ dependencies: { vite: "1.0.0" } }));
    await Bun.write(join(dir, ".env.local"), "CLERK_SECRET_KEY=sk_test_x\n");
  });

  test("an empty value: writes .env.development.local", async () => {
    await Bun.write(join(dir, ".env.development"), "VITE_CLERK_PUBLISHABLE_KEY=\n");

    expect(await defaultTargetFile(dir, ".env.local")).toBe(".env.development.local");
  });

  test("a line the CLI can't parse: writes .env.development.local, and warns naming the file", async () => {
    await Bun.write(join(dir, ".env.development"), "VITE_CLERK_PUBLISHABLE_KEY = pk_test_old\n");

    expect(await defaultTargetFile(dir, ".env.local")).toBe(".env.development.local");
    expect(Bun.stripANSI(captured.err)).toContain(
      "`.env.development` has a `VITE_CLERK_PUBLISHABLE_KEY` line the CLI can't read",
    );
  });

  // A rejecting spy stands in for the unreadable file: chmod doesn't stop root in CI.
  test("a file the CLI can't read: writes .env.development.local", async () => {
    await Bun.write(join(dir, ".env.development"), "OTHER=1\n");
    const real = localKeys.clerkLinesIn;
    const scan = spyOn(localKeys, "clerkLinesIn").mockImplementation(async (cwd, file) =>
      file === ".env.development" ? "unreadable" : real(cwd, file),
    );
    try {
      expect(await defaultTargetFile(dir, ".env.local")).toBe(".env.development.local");
    } finally {
      scan.mockRestore();
    }
  });

  test("a .env.development.local git doesn't ignore: keeps .env.local, and warns naming it", async () => {
    await Bun.write(join(dir, ".env.development"), "VITE_CLERK_PUBLISHABLE_KEY=\n");
    const ignored = spyOn(git, "isGitIgnored").mockResolvedValue(false);
    try {
      expect(await defaultTargetFile(dir, ".env.local")).toBe(".env.local");
      expect(Bun.stripANSI(captured.err)).toContain(
        "`.env.development.local` isn't ignored by git, so the keys go to `.env.local`",
      );
    } finally {
      ignored.mockRestore();
    }
  });

  test("no Clerk line there: keeps .env.local", async () => {
    await Bun.write(join(dir, ".env.development"), "OTHER=1\n");

    expect(await defaultTargetFile(dir, ".env.local")).toBe(".env.local");
  });
});
