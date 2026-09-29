import { describe, expect, test } from "bun:test";
import { resolveFirebaseHashConfig } from "./firebase-hash.ts";

const ALL_FLAGS = {
  firebaseSignerKey: "SIGNER",
  firebaseSaltSeparator: "Bw==",
  firebaseRounds: 8,
  firebaseMemCost: 14,
};

describe("gating on the source", () => {
  test.each([["clerk"], ["supabase"], ["auth0"], ["authjs"], ["betterauth"]])(
    "ignores even explicit flags for the %s source",
    (transformer) => {
      expect(resolveFirebaseHashConfig(ALL_FLAGS, transformer)).toBeUndefined();
    },
  );

  test("resolves nothing before the platform is known", () => {
    expect(resolveFirebaseHashConfig(ALL_FLAGS, undefined)).toBeUndefined();
  });
});

describe("on a firebase run", () => {
  test("builds the config from flags", () => {
    expect(resolveFirebaseHashConfig(ALL_FLAGS, "firebase")).toEqual({
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
  ] as const)("rejects a flag set missing %s, naming it", (omit, flag) => {
    const partial = { ...ALL_FLAGS };
    delete (partial as Record<string, unknown>)[omit];

    expect(() => resolveFirebaseHashConfig(partial, "firebase")).toThrow(new RegExp(flag));
  });

  test("names every missing flag at once", () => {
    expect(() => resolveFirebaseHashConfig({ firebaseSignerKey: "SIGNER" }, "firebase")).toThrow(
      /--firebase-salt-separator.*--firebase-rounds.*--firebase-mem-cost/,
    );
  });

  test("returns nothing when no flag supplies a config", () => {
    expect(resolveFirebaseHashConfig({}, "firebase")).toBeUndefined();
  });
});
