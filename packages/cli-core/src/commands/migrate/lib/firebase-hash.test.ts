import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { resolveFirebaseHashConfig } from "./firebase-hash.ts";

const captured = useCaptureLog();

const ALL_FLAGS = {
  firebaseSignerKey: "SIGNER",
  firebaseSaltSeparator: "Bw==",
  firebaseRounds: 8,
  firebaseMemCost: 14,
};

const ENV = {
  CLERK_FIREBASE_SIGNER_KEY: "ENV_SIGNER",
  CLERK_FIREBASE_SALT_SEPARATOR: "Bw==",
  CLERK_FIREBASE_ROUNDS: "8",
  CLERK_FIREBASE_MEM_COST: "14",
};

let workDir: string;
let originalCwd: string;

const setEnv = (vars: Partial<typeof ENV>) => Object.assign(process.env, vars);

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-fbhash-")));
  process.chdir(workDir);
});

afterEach(() => {
  for (const name of Object.keys(ENV)) delete process.env[name];
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("gating on the transformer", () => {
  // `migrate run` is one command for every platform, so a signer key left in
  // .env.clerk-migrate after a Firebase migration is in scope for whatever runs
  // next unless the transformer says otherwise.
  test.each([["clerk"], ["supabase"], ["auth0"], ["authjs"], ["betterauth"]])(
    "reads nothing for the %s transformer",
    async (transformer) => {
      setEnv(ENV);
      expect(await resolveFirebaseHashConfig({}, transformer)).toBeUndefined();
    },
  );

  test("stays silent about a complete set on another platform's run", async () => {
    setEnv(ENV);
    await resolveFirebaseHashConfig({}, "supabase");
    expect(captured.err).toBe("");
  });

  // The case that regressed: half a set used to fail every later run.
  test("stays silent about a partial set on another platform's run", async () => {
    fs.writeFileSync(path.join(workDir, ".env.clerk-migrate"), "CLERK_FIREBASE_SIGNER_KEY=left\n");

    expect(await resolveFirebaseHashConfig({}, "supabase")).toBeUndefined();
    expect(captured.err).toBe("");
  });

  test("ignores even explicit flags when the platform is not firebase", async () => {
    expect(await resolveFirebaseHashConfig(ALL_FLAGS, "supabase")).toBeUndefined();
  });

  test("resolves nothing before the platform is known", async () => {
    setEnv(ENV);
    expect(await resolveFirebaseHashConfig({}, undefined)).toBeUndefined();
  });
});

describe("on a firebase run", () => {
  test("builds the config from flags", async () => {
    expect(await resolveFirebaseHashConfig(ALL_FLAGS, "firebase")).toEqual({
      base64_signer_key: "SIGNER",
      base64_salt_separator: "Bw==",
      rounds: 8,
      mem_cost: 14,
    });
  });

  test("falls back to the environment", async () => {
    setEnv(ENV);
    expect((await resolveFirebaseHashConfig({}, "firebase"))?.base64_signer_key).toBe("ENV_SIGNER");
  });

  test("reads .env.clerk-migrate when the variable is not exported", async () => {
    fs.writeFileSync(
      path.join(workDir, ".env.clerk-migrate"),
      Object.entries(ENV)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );

    expect((await resolveFirebaseHashConfig({}, "firebase"))?.rounds).toBe(8);
  });

  test("prefers a flag over the environment", async () => {
    setEnv(ENV);
    expect((await resolveFirebaseHashConfig(ALL_FLAGS, "firebase"))?.base64_signer_key).toBe(
      "SIGNER",
    );
  });

  test("fills only the gaps the flags left", async () => {
    setEnv({ CLERK_FIREBASE_ROUNDS: "8", CLERK_FIREBASE_MEM_COST: "14" });

    expect(
      await resolveFirebaseHashConfig(
        { firebaseSignerKey: "SIGNER", firebaseSaltSeparator: "Bw==" },
        "firebase",
      ),
    ).toEqual({
      base64_signer_key: "SIGNER",
      base64_salt_separator: "Bw==",
      rounds: 8,
      mem_cost: 14,
    });
  });

  // A digest built from a partial set is well-formed but verifies against
  // nothing, so every migrated user would silently fail to sign in.
  test.each([
    ["firebaseSignerKey", "--firebase-signer-key"],
    ["firebaseSaltSeparator", "--firebase-salt-separator"],
    ["firebaseRounds", "--firebase-rounds"],
    ["firebaseMemCost", "--firebase-mem-cost"],
  ] as const)("rejects a flag set missing %s, naming it", async (omit, flag) => {
    const partial = { ...ALL_FLAGS };
    delete (partial as Record<string, unknown>)[omit];

    await expect(resolveFirebaseHashConfig(partial, "firebase")).rejects.toThrow(new RegExp(flag));
  });

  test("names every missing flag at once", async () => {
    await expect(
      resolveFirebaseHashConfig({ firebaseSignerKey: "SIGNER" }, "firebase"),
    ).rejects.toThrow(/--firebase-salt-separator.*--firebase-rounds.*--firebase-mem-cost/);
  });

  // Saved config is a leftover, not an instruction — but on a Firebase import
  // it is the reason the passwords will not come across, so it is said aloud.
  test("warns and continues when only saved config is partial", async () => {
    setEnv({ CLERK_FIREBASE_SIGNER_KEY: "ENV_SIGNER" });

    expect(await resolveFirebaseHashConfig({}, "firebase")).toBeUndefined();
    expect(captured.err).toContain("Ignoring an incomplete Firebase hash configuration");
  });

  test("still fails when a flag supplied part of the set", async () => {
    setEnv({ CLERK_FIREBASE_SIGNER_KEY: "ENV_SIGNER" });

    await expect(resolveFirebaseHashConfig({ firebaseRounds: 8 }, "firebase")).rejects.toThrow(
      /--firebase-salt-separator/,
    );
  });

  // An empty variable is how a shell spells "unset".
  test("ignores an empty variable", async () => {
    setEnv({ CLERK_FIREBASE_SIGNER_KEY: "" });
    expect(await resolveFirebaseHashConfig({}, "firebase")).toBeUndefined();
  });

  test("returns nothing when neither flags nor the environment supply a config", async () => {
    expect(await resolveFirebaseHashConfig({}, "firebase")).toBeUndefined();
  });
});
