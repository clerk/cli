import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "../../../lib/errors.ts";
import { loadUsersFromFile, transformUsers } from "../lib/transform.ts";
import type { FirebaseHashConfig } from "../types.ts";
import { getSource, isSourcePath, sourceKeys, sources } from "./registry.ts";
import { isVerified } from "./shared.ts";

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
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-sources-")));
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
  return loadUsersFromFile(file, key, { context });
}

const one = (key: string, record: Record<string, unknown>, context = {}) =>
  transformUsers([record], key, { validate: false, context }).transformedData[0] as
    | Record<string, unknown>
    | undefined;

describe("registry", () => {
  test("registers all seven platforms", () => {
    expect(sourceKeys()).toEqual([
      "clerk",
      "auth0",
      "authjs",
      "betterauth",
      "firebase",
      "supabase",
      "workos",
    ]);
  });

  test.each([...sources])("$key maps a source field to userId", (source) => {
    expect(Object.values(source.transformer)).toContain("userId");
  });

  test.each([...sources])("$key carries a label and description", (source) => {
    expect(source.label.length).toBeGreaterThan(0);
    expect(source.description.length).toBeGreaterThan(0);
  });

  test.each([...sources])("$key says what it carries, with a note for each", (source) => {
    for (const carry of Object.values(source.carries)) {
      expect(["yes", "no", "partial"]).toContain(carry.level);
      expect(carry.note.length).toBeGreaterThan(0);
    }
  });

  test("throws for an unregistered key", () => {
    expect(() => getSource("okta")).toThrow(/Source not found/);
  });
});

describe("isSourcePath", () => {
  test.each([["./mine.ts"], ["../up/mine.js"], ["/abs/mine.mjs"], ["mine.ts"], ["dir/mine.js"]])(
    "%s is a path",
    (value) => {
      expect(isSourcePath(value)).toBe(true);
    },
  );

  test.each([["clerk"], ["betterauth"], ["okta"]])("%s is a key", (value) => {
    expect(isSourcePath(value)).toBe(false);
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

  // `user_metadata` is the user's own to edit in Auth0, which is what Clerk's
  // unsafe metadata is; public metadata is read-only to the user.
  test("sends user_metadata to unsafe metadata and app_metadata to private", async () => {
    const { users } = await load("auth0", [
      {
        ...base,
        email_verified: true,
        user_metadata: { theme: "dark" },
        app_metadata: { plan: "pro" },
      },
    ]);
    expect(users[0]?.unsafeMetadata).toEqual({ theme: "dark" });
    expect(users[0]?.publicMetadata).toBeUndefined();
    expect(users[0]?.privateMetadata).toEqual({ plan: "pro" });
  });

  test.each([
    [true, true],
    ["true", true],
    [false, undefined],
    [undefined, undefined],
  ])("blocked=%p is carried as banned=%p", (blocked, expected) => {
    expect(one("auth0", { ...base, blocked })?.banned).toBe(expected as boolean | undefined);
  });

  test("splits name when given_name and family_name are absent", () => {
    const user = one("auth0", { ...base, name: "Ada King Lovelace" });
    expect(user).toMatchObject({ firstName: "Ada", lastName: "King Lovelace" });
  });

  test("prefers given_name/family_name over name", () => {
    const user = one("auth0", { ...base, name: "a@x.dev", given_name: "Ada", family_name: "L" });
    expect(user).toMatchObject({ firstName: "Ada", lastName: "L" });
  });

  test("leaves a one-word name (Auth0's email default) unset", () => {
    const user = one("auth0", { ...base, name: "a@x.dev" });
    expect(user?.firstName).toBeUndefined();
  });
});

describe("workos", () => {
  const base = { id: "user_01ABC", email: "a@x.dev" };

  test("maps identity, name and metadata onto the Clerk schema", async () => {
    const { users } = await load("workos", [
      { ...base, email_verified: true, first_name: "Ada", last_name: "Lovelace" },
    ]);
    expect(users[0]).toMatchObject({
      userId: "user_01ABC",
      email: "a@x.dev",
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  test.each([
    [true, "email", undefined],
    [false, undefined, "a@x.dev"],
    [undefined, undefined, "a@x.dev"],
  ])("email_verified=%p routes the address correctly", (verified, kept, unverified) => {
    const user = one("workos", { ...base, email_verified: verified });
    expect(user?.email).toBe(kept ? "a@x.dev" : undefined);
    expect(user?.unverifiedEmailAddresses).toBe(unverified);
  });

  test("sends metadata to unsafe metadata", async () => {
    const { users } = await load("workos", [
      { ...base, email_verified: true, metadata: { plan: "pro" } },
    ]);
    expect(users[0]?.unsafeMetadata).toEqual({ plan: "pro" });
  });

  // The WorkOS id stays the Clerk external_id; the tenant's own ID is kept
  // where users cannot edit it.
  test("puts WorkOS's external_id in private metadata", async () => {
    const { users } = await load("workos", [
      { ...base, email_verified: true, external_id: "cust_1" },
    ]);
    expect(users[0]?.userId).toBe("user_01ABC");
    expect(users[0]?.privateMetadata).toEqual({ workosExternalId: "cust_1" });
    expect("workosExternalId" in (users[0] ?? {})).toBe(false);
  });

  // No other transformer omits it. WorkOS never returns a digest, so naming a
  // hasher would imply a password column that cannot exist.
  test("names no password hasher, because WorkOS returns no hashes", () => {
    expect(getSource("workos").defaults).toBeUndefined();
  });

  // The export carries these so whoever runs the migration can see who used
  // social sign-in; Clerk's import has no field for them.
  test("drops OAuth identities carried through from the export", async () => {
    const { users } = await load("workos", [
      { ...base, email_verified: true, identities: [{ provider: "GoogleOAuth", idp_id: "1" }] },
    ]);
    expect(users[0]?.userId).toBe("user_01ABC");
    expect("identities" in (users[0] ?? {})).toBe(false);
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

  // Better Auth's own scrypt: a 16-byte hex salt, a colon, a 64-byte hex key.
  const SALT = "a".repeat(32);
  const KEY = "b".repeat(128);

  test.each([
    [`${SALT}:${KEY}`, `scrypt:16384:16:1$${SALT}$${KEY}`, "scrypt_werkzeug"],
    ["$2a$10$hash", "$2a$10$hash", "bcrypt"],
    ["$2b$10$hash", "$2b$10$hash", "bcrypt"],
    ["$2y$10$hash", "$2y$10$hash", "bcrypt"],
    [
      "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA",
      "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA",
      "argon2id",
    ],
    [
      "$argon2i$v=19$m=4096,t=3,p=1$c2FsdA$aGFzaA",
      "$argon2i$v=19$m=4096,t=3,p=1$c2FsdA$aGFzaA",
      "argon2i",
    ],
  ])("detects the hasher per user: %s", async (stored, password, passwordHasher) => {
    const { users } = await load("betterauth", [{ ...base, password_hash: stored }]);
    expect(users[0]).toMatchObject({ password, passwordHasher });
    expect(users[0]?.passwordDropped).toBeUndefined();
  });

  // Imported without the password rather than rejected: the user can still
  // sign in another way, or reset it.
  test.each([["plaintext"], ["$pbkdf2$abc"], [`${SALT}:short`]])(
    "drops a password it cannot verify (%s) and imports the user",
    async (stored) => {
      const { users, validationFailed } = await load("betterauth", [
        { ...base, password_hash: stored },
      ]);
      expect(validationFailed).toBe(0);
      expect(users[0]?.password).toBeUndefined();
      expect(users[0]?.passwordHasher).toBeUndefined();
      expect(users[0]?.passwordDropped).toBe(true);
    },
  );

  test("names no hasher for a user without a password", async () => {
    const { users } = await load("betterauth", [base]);
    expect(users[0]?.passwordHasher).toBeUndefined();
    expect(users[0]?.passwordDropped).toBeUndefined();
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
    [1, true],
    ["true", true],
    [false, undefined],
    [0, undefined],
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

  test.each([
    [true, true],
    ["true", true],
    [false, undefined],
    [undefined, undefined],
  ])("disabled=%p carries as banned=%p", (disabled, expected) => {
    expect(one("firebase", { ...base, disabled })?.banned).toBe(expected as boolean | undefined);
  });
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

  test.each([
    ["14165550123", "+14165550123"],
    ["+14165550123", "+14165550123"],
  ])("phone %p imports as %p", (phone, expected) => {
    const user = one("supabase", { ...base, phone, phone_confirmed_at: "2024-06-29 20:25:06+00" });
    expect(user?.phone).toBe(expected);
  });

  test("adds the + to an unconfirmed phone too", () => {
    expect(one("supabase", { ...base, phone: "14165550123" })?.unverifiedPhoneNumbers).toBe(
      "+14165550123",
    );
  });

  // An expired ban means the user is active again in Supabase.
  test.each([
    ["2999-01-01 00:00:00+00", true],
    ["2020-01-01 00:00:00+00", undefined],
    [undefined, undefined],
  ])("banned_until=%p carries as banned=%p", (bannedUntil, expected) => {
    const user = one("supabase", { ...base, banned_until: bannedUntil });
    expect(user?.banned).toBe(expected as boolean | undefined);
    expect("bannedUntil" in (user ?? {})).toBe(false);
  });

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
    "%s reports a user with no identifier instead of crashing",
    async (key, record) => {
      const { users, validationFailed, failures } = await load(key, [
        record,
        { ...record, ...identifierFor(key) },
      ]);

      expect(validationFailed).toBe(1);
      expect(users).toHaveLength(1);

      expect(failures).toHaveLength(1);
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
