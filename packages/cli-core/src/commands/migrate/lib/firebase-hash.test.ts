import { describe, expect, test } from "bun:test";
import {
  fingerprintFirebaseHashConfig,
  firebaseHashConfigProblem,
  resolveFirebaseHashConfig,
} from "./firebase-hash.ts";

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
    expect(resolveFirebaseHashConfig({}, "firebase", {})).toBeUndefined();
  });
});

// The variables keep the signer key out of argv, shell history and `ps`.
describe("from CLERK_FIREBASE_* variables", () => {
  const ENV = {
    CLERK_FIREBASE_SIGNER_KEY: "SIGNER",
    CLERK_FIREBASE_SALT_SEPARATOR: "Bw==",
    CLERK_FIREBASE_ROUNDS: "8",
    CLERK_FIREBASE_MEM_COST: "14",
  };

  test("builds the config from all four", () => {
    expect(resolveFirebaseHashConfig({}, "firebase", ENV)).toEqual({
      base64_signer_key: "SIGNER",
      base64_salt_separator: "Bw==",
      rounds: 8,
      mem_cost: 14,
    });
  });

  test("a flag wins over its variable", () => {
    expect(
      resolveFirebaseHashConfig({ firebaseSignerKey: "ROTATED" }, "firebase", ENV)
        ?.base64_signer_key,
    ).toBe("ROTATED");
  });

  test("a partial set names each missing flag and variable", () => {
    expect(() =>
      resolveFirebaseHashConfig({}, "firebase", { CLERK_FIREBASE_SIGNER_KEY: "SIGNER" }),
    ).toThrow(/--firebase-rounds \(or CLERK_FIREBASE_ROUNDS\)/);
  });

  test("refuses a cost that is not a whole number", () => {
    expect(() =>
      resolveFirebaseHashConfig({}, "firebase", { ...ENV, CLERK_FIREBASE_ROUNDS: "eight" }),
    ).toThrow(/CLERK_FIREBASE_ROUNDS must be a positive whole number/);
  });
});

// Clerk's bounds: clerk_go pkg/hash/scrypt.go.
describe("firebaseHashConfigProblem", () => {
  const good = {
    base64_signer_key: "SIGNER",
    base64_salt_separator: "Bw==",
    rounds: 8,
    mem_cost: 14,
  };

  test("passes Firebase's usual parameters", () => {
    expect(firebaseHashConfigProblem(good)).toBeUndefined();
  });

  // Clerk pads a short final group itself, and reads the URL-safe alphabet.
  test.each(["Bw", "Bw==", "a-b_", "YWJjZA"])("passes %s, which Clerk decodes", (separator) => {
    expect(
      firebaseHashConfigProblem({ ...good, base64_salt_separator: separator }),
    ).toBeUndefined();
  });

  // Clerk decodes it to no bytes; some projects have no separator.
  test("passes an empty salt separator", () => {
    expect(firebaseHashConfigProblem({ ...good, base64_salt_separator: "" })).toBeUndefined();
  });

  test.each([
    // Clerk pads to a multiple of four, then decodes strictly.
    ["a one-character key", { base64_signer_key: "A" }, /signer key is not base64/],
    ["padding after a full group", { base64_signer_key: "AAAA=" }, /signer key is not base64/],
    ["two pads after a full group", { base64_signer_key: "AAAA==" }, /signer key is not base64/],
    ["an empty key", { base64_signer_key: "" }, /signer key is not base64/],
    [
      "a signer key that is not base64",
      { base64_signer_key: "not base64!" },
      /signer key is not base64/,
    ],
    [
      "a separator with the digest's $",
      { base64_salt_separator: "Bw$" },
      /salt separator is not base64/,
    ],
    ["rounds of 0", { rounds: 0 }, /rounds must be a whole number from 1 to 16, not 0/],
    ["rounds of 17", { rounds: 17 }, /rounds must be a whole number from 1 to 16, not 17/],
    ["a fractional memory cost", { mem_cost: 14.5 }, /memory cost must be a whole number/],
  ])("names %s", (_label, change, expected) => {
    expect(firebaseHashConfigProblem({ ...good, ...change })).toMatch(expected);
  });
});

describe("fingerprintFirebaseHashConfig", () => {
  const config = {
    base64_signer_key: "SIGNER",
    base64_salt_separator: "Bw==",
    rounds: 8,
    mem_cost: 14,
  };

  test("is the same for the same parameters, and holds no signer key", () => {
    const fingerprint = fingerprintFirebaseHashConfig(config);
    expect(fingerprintFirebaseHashConfig({ ...config })).toBe(fingerprint);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toContain("SIGNER");
  });

  test("changes with any parameter", () => {
    const fingerprint = fingerprintFirebaseHashConfig(config);
    expect(fingerprintFirebaseHashConfig({ ...config, base64_signer_key: "OTHER" })).not.toBe(
      fingerprint,
    );
    expect(fingerprintFirebaseHashConfig({ ...config, rounds: 9 })).not.toBe(fingerprint);
  });
});
