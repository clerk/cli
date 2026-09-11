import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "../../../lib/errors.ts";
import { getLogDir } from "../lib/logger.ts";
import { loadUsersFromFile, transformUsers } from "../lib/transform.ts";
import type { FirebaseHashConfig } from "../types.ts";
import { getTransformer, transformerKeys, transformers } from "./registry.ts";
import { isVerified } from "./shared.ts";

const DATE_TIME = "2026-01-01T00:00:00";

const FIREBASE_HASH: FirebaseHashConfig = {
  base64_signer_key: "SIGNERKEY==",
  base64_salt_separator: "Bw==",
  rounds: 8,
  mem_cost: 14,
};

let workDir: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-transformers-")));
  process.chdir(workDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Writes `records` to a uniquely-named file and loads it through `key`. */
async function load(key: string, records: unknown, ext = "json", context = {}) {
  const file = `${key}-${Math.abs(JSON.stringify(records).length)}-${ext}.${ext}`;
  fs.writeFileSync(
    path.join(workDir, file),
    typeof records === "string" ? records : JSON.stringify(records),
  );
  return loadUsersFromFile(file, key, DATE_TIME, { context });
}

const one = (key: string, record: Record<string, unknown>, context = {}) =>
  transformUsers([record], key, DATE_TIME, { validate: false, context }).transformedData[0] as
    | Record<string, unknown>
    | undefined;

describe("registry", () => {
  test("registers all six platforms", () => {
    expect(transformerKeys()).toEqual([
      "clerk",
      "auth0",
      "authjs",
      "betterauth",
      "firebase",
      "supabase",
    ]);
  });

  test.each([...transformers])("$key maps a source field to userId", (transformer) => {
    expect(Object.values(transformer.transformer)).toContain("userId");
  });

  test.each([...transformers])("$key carries a label and description", (transformer) => {
    expect(transformer.label.length).toBeGreaterThan(0);
    expect(transformer.description.length).toBeGreaterThan(0);
  });

  test("throws for an unregistered key", () => {
    expect(() => getTransformer("okta")).toThrow(/Transformer not found/);
  });
});

describe("isVerified", () => {
  // A CSV export stringifies everything, so the boolean style must read
  // "false" as false. Treating it as truthy would mark unconfirmed addresses
  // verified on import — the exact thing the routing exists to prevent.
  test.each([
    [true, true],
    ["true", true],
    [1, true],
    ["1", true],
    [false, false],
    ["false", false],
    [0, false],
    ["0", false],
    ["", false],
    [null, false],
    [undefined, false],
  ])("boolean style: %p -> %p", (value, expected) => {
    expect(isVerified(value, "boolean")).toBe(expected);
  });

  // The timestamp style is presence-based: any real confirmation time counts,
  // and SQL NULL arrives from a CSV export as one of several spellings.
  test.each([
    ["2024-06-29 20:25:06+00", true],
    ["2024-01-15T10:30:00.000Z", true],
    ["", false],
    ["   ", false],
    ["null", false],
    ["NULL", false],
    ["\\N", false],
    [null, false],
    [undefined, false],
  ])("timestamp style: %p -> %p", (value, expected) => {
    expect(isVerified(value, "timestamp")).toBe(expected);
  });
});

describe("auth0", () => {
  const base = { user_id: "auth0|abc", email: "a@x.dev", passwordHash: "$2b$10$hash" };

  test("maps identity, name and metadata onto the Clerk schema", async () => {
    const { users } = await load("auth0", [
      { ...base, email_verified: true, given_name: "Ada", family_name: "Lovelace" },
    ]);
    expect(users[0]).toMatchObject({
      userId: "auth0|abc",
      email: "a@x.dev",
      firstName: "Ada",
      lastName: "Lovelace",
      password: "$2b$10$hash",
      passwordHasher: "bcrypt",
    });
  });

  test.each([
    [true, "email", undefined],
    [false, undefined, "a@x.dev"],
    [undefined, undefined, "a@x.dev"],
  ])("email_verified=%p routes the address correctly", (verified, kept, unverified) => {
    const user = one("auth0", { ...base, email_verified: verified });
    expect(user?.email).toBe(kept ? "a@x.dev" : undefined);
    expect(user?.unverifiedEmailAddresses).toBe(unverified);
  });

  test("routes an unverified phone away from the primary field", () => {
    const user = one("auth0", { ...base, phone_number: "+15555550100", phone_verified: false });
    expect(user?.phone).toBeUndefined();
    expect(user?.unverifiedPhoneNumbers).toBe("+15555550100");
  });

  test("drops the platform's verification markers", () => {
    const user = one("auth0", { ...base, email_verified: true, phone_verified: true });
    expect("emailVerified" in (user ?? {})).toBe(false);
    expect("phoneVerified" in (user ?? {})).toBe(false);
  });

  test("keeps user_metadata public and app_metadata private", async () => {
    const { users } = await load("auth0", [
      {
        ...base,
        email_verified: true,
        user_metadata: { theme: "dark" },
        app_metadata: { plan: "pro" },
      },
    ]);
    expect(users[0]?.publicMetadata).toEqual({ theme: "dark" });
    expect(users[0]?.privateMetadata).toEqual({ plan: "pro" });
  });
});

describe("authjs", () => {
  const base = { id: "cuid1", email: "a@x.dev" };

  test("treats a confirmation timestamp as verified", () => {
    const user = one("authjs", { ...base, email_verified: "2024-01-15T10:30:00.000Z" });
    expect(user?.email).toBe("a@x.dev");
    expect(user?.unverifiedEmailAddresses).toBeUndefined();
  });

  test.each([[null], [""], [undefined]])("treats email_verified=%p as unverified", (value) => {
    const user = one("authjs", { ...base, email_verified: value });
    expect(user?.unverifiedEmailAddresses).toBe("a@x.dev");
  });

  test.each([
    ["Jane Doe", "Jane", "Doe"],
    ["Mary Jane Watson", "Mary", "Jane Watson"],
    ["  Ada   Lovelace  ", "Ada", "Lovelace"],
  ])("splits %p into %p / %p", (name, firstName, lastName) => {
    const user = one("authjs", { ...base, name });
    expect(user?.firstName).toBe(firstName);
    expect(user?.lastName).toBe(lastName);
  });

  test("leaves a single-word name unsplit rather than inventing a last name", () => {
    const user = one("authjs", { ...base, name: "Prince" });
    expect(user?.firstName).toBeUndefined();
    expect(user?.lastName).toBeUndefined();
    expect("name" in (user ?? {})).toBe(false);
  });

  test("imports without a password, since Auth.js core is passwordless", async () => {
    const { users } = await load("authjs", [{ ...base, email_verified: "2024-01-01" }]);
    expect(users[0]?.password).toBeUndefined();
    expect(users[0]?.passwordHasher).toBeUndefined();
  });
});

describe("betterauth", () => {
  const base = { user_id: "ba1", email: "a@x.dev", email_verified: true };

  test("maps the credential hash and defaults the hasher to bcrypt", async () => {
    const { users } = await load("betterauth", [{ ...base, password_hash: "$2a$10$hash" }]);
    expect(users[0]).toMatchObject({ password: "$2a$10$hash", passwordHasher: "bcrypt" });
  });

  test("routes an unverified phone", () => {
    const user = one("betterauth", {
      ...base,
      phone_number: "+15555550100",
      phone_number_verified: false,
    });
    expect(user?.unverifiedPhoneNumbers).toBe("+15555550100");
  });

  test.each([
    [true, true],
    [false, undefined],
    [undefined, undefined],
  ])("banned=%p is carried through as %p", (banned, expected) => {
    expect(one("betterauth", { ...base, banned })?.banned).toBe(expected as boolean | undefined);
  });

  test("drops plugin-only columns during validation", async () => {
    const { users } = await load("betterauth", [
      { ...base, role: "admin", display_username: "ADA", two_factor_enabled: true },
    ]);
    const user = users[0] as Record<string, unknown>;
    expect("role" in user).toBe(false);
    expect("display_username" in user).toBe(false);
    expect("two_factor_enabled" in user).toBe(false);
  });
});

describe("firebase", () => {
  const base = { localId: "fb1", email: "a@x.dev", emailVerified: true };
  const withHash = { ...base, passwordHash: "SGFzaA==", salt: "U2FsdA==" };

  test("builds the scrypt digest Clerk expects, parameters inline", async () => {
    const { users } = await load("firebase", { users: [withHash] }, "json", {
      firebaseHashConfig: FIREBASE_HASH,
    });
    expect(users[0]?.password).toBe("SGFzaA==$U2FsdA==$SIGNERKEY==$Bw==$8$14");
    expect(users[0]?.passwordHasher).toBe("scrypt_firebase");
  });

  test("refuses to import hashes without the project's hash parameters", async () => {
    await expect(load("firebase", { users: [withHash] })).rejects.toThrow(
      /Firebase password hashes/,
    );
  });

  test("imports a passwordless export with no hash parameters at all", async () => {
    const { users } = await load("firebase", { users: [base] });
    expect(users).toHaveLength(1);
    expect(users[0]?.password).toBeUndefined();
  });

  test("unwraps the { users: [...] } export shape", async () => {
    const { users } = await load("firebase", { users: [base, { ...base, localId: "fb2" }] });
    expect(users.map((u) => u.userId)).toEqual(["fb1", "fb2"]);
  });

  test("accepts a bare array too", async () => {
    const { users } = await load("firebase", [base]);
    expect(users).toHaveLength(1);
  });

  test("rejects a JSON export that is neither", async () => {
    await expect(load("firebase", { records: [] })).rejects.toThrow(CliError);
  });

  test("prepends headers to a headerless CSV export", async () => {
    const csv = "fb9,a@x.dev,true,,,Ada Lovelace,,,,,,,,,,,,,,,,,,1704067200000,,,,,\n";
    const { users } = await load("firebase", csv, "csv");
    expect(users[0]).toMatchObject({ userId: "fb9", email: "a@x.dev", firstName: "Ada" });
  });

  test.each([
    ["1704067200000", "2024-01-01T00:00:00.000Z"],
    [1704067200000, "2024-01-01T00:00:00.000Z"],
  ])("converts the Unix-millisecond createdAt %p", (createdAt, expected) => {
    expect(one("firebase", { ...base, createdAt })?.createdAt).toBe(expected);
  });

  test.each([
    [true, true],
    ["true", true],
    [false, false],
    ["false", false],
  ])("emailVerified=%p keeps the address primary: %p", (emailVerified, verified) => {
    const user = one("firebase", { ...base, emailVerified });
    expect(user?.email !== undefined).toBe(verified);
  });
});

describe("supabase", () => {
  const base = { id: "sb1", email: "a@x.dev", email_confirmed_at: "2024-06-29 20:25:06.126079+00" };

  test("maps the bcrypt password and converts the PostgreSQL timestamp", async () => {
    const { users } = await load("supabase", [
      { ...base, encrypted_password: "$2b$10$hash", created_at: "2024-06-29 20:25:06.126079+00" },
    ]);
    expect(users[0]).toMatchObject({
      password: "$2b$10$hash",
      passwordHasher: "bcrypt",
      createdAt: "2024-06-29T20:25:06.126Z",
    });
  });

  test.each([
    ["2024-06-29 20:25:06+00", true],
    [null, false],
    ["", false],
  ])("email_confirmed_at=%p means verified: %p", (confirmedAt, verified) => {
    const user = one("supabase", { ...base, email_confirmed_at: confirmedAt });
    expect(user?.email !== undefined).toBe(verified);
  });

  test("falls back to user metadata for a missing first name", () => {
    const user = one("supabase", {
      ...base,
      raw_user_meta_data: { display_name: "Ada Lovelace" },
    });
    expect(user?.firstName).toBe("Ada");
    expect(user?.lastName).toBe("Lovelace");
  });

  test("prefers explicit name columns over metadata", () => {
    const user = one("supabase", {
      ...base,
      first_name: "Grace",
      raw_user_meta_data: { display_name: "Ada Lovelace" },
    });
    expect(user?.firstName).toBe("Grace");
  });

  test.each([
    ["ada#0", "ada"],
    ["ada#1234", "ada"],
  ])("strips the Discord discriminator from %p", (displayName, expected) => {
    const user = one("supabase", { ...base, raw_user_meta_data: { display_name: displayName } });
    expect(user?.firstName).toBe(expected);
  });

  test("drops a name that was nothing but a discriminator", () => {
    const user = one("supabase", { ...base, first_name: "#0" });
    expect(user?.firstName).toBeUndefined();
  });
});

describe("invalid records", () => {
  const INVALID: [string, Record<string, unknown>][] = [
    ["auth0", { user_id: "a1" }],
    ["authjs", { id: "a2" }],
    ["betterauth", { user_id: "a3" }],
    ["firebase", { localId: "a4" }],
    ["supabase", { id: "a5" }],
  ];

  test.each(INVALID)(
    "%s logs a user with no identifier instead of crashing",
    async (key, record) => {
      fs.rmSync(getLogDir(), { recursive: true, force: true });

      const { users, validationFailed } = await load(key, [
        record,
        { ...record, ...identifierFor(key) },
      ]);

      expect(validationFailed).toBe(1);
      expect(users).toHaveLength(1);

      const logged = fs
        .readdirSync(getLogDir())
        .flatMap((name) =>
          fs.readFileSync(path.join(getLogDir(), name), "utf-8").trim().split("\n"),
        )
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(logged.some((entry) => entry.status === "fail")).toBe(true);
    },
  );

  test.each(INVALID)("%s logs a malformed email rather than sending it", async (key, record) => {
    const { users, validationFailed } = await load(key, [
      { ...record, ...identifierFor(key, "not-an-email") },
    ]);
    expect(validationFailed).toBe(1);
    expect(users).toHaveLength(0);
  });
});

/** The per-platform source field that becomes a Clerk identifier. */
function identifierFor(key: string, email = "ok@x.dev"): Record<string, unknown> {
  if (key === "auth0") return { email, email_verified: true };
  if (key === "authjs") return { email, email_verified: "2024-01-01" };
  if (key === "betterauth") return { email, email_verified: true };
  if (key === "firebase") return { email, emailVerified: true };
  return { email, email_confirmed_at: "2024-01-01 00:00:00+00" };
}
