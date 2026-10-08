import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadUsersFromFile, transformUsers } from "../lib/transform.ts";
import { getSource, sourceKeys, sources } from "./registry.ts";
import { isVerified } from "./shared.ts";

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
  test("registers the built-in platforms", () => {
    expect(sourceKeys()).toEqual(["clerk", "supabase"]);
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
    // A CSV re-saved by a spreadsheet, or written by psql.
    ["TRUE", true],
    ["FALSE", false],
    ["t", true],
    ["f", false],
    ["Yes", true],
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

describe("supabase", () => {
  // `NULL` is how SQL tools write an empty column into a CSV.
  test("reads NULL cells in a CSV as empty, not as values", async () => {
    const { users, failures } = await load(
      "supabase",
      [
        "id,email,email_confirmed_at,encrypted_password,phone,raw_user_meta_data,deleted_at",
        "s1,a@x.dev,2024-01-01,NULL,NULL,NULL,NULL",
      ].join("\n"),
      "csv",
    );

    expect(failures).toEqual([]);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ userId: "s1", email: "a@x.dev" });
    for (const field of ["skipReason", "phone", "unverifiedPhoneNumbers", "passwordDropped"]) {
      expect(users[0]).not.toHaveProperty(field);
    }
  });

  test("keeps a name that reads as NULL", async () => {
    const { users } = await load(
      "supabase",
      ["id,email,email_confirmed_at,last_name,deleted_at", "s2,b@x.dev,2024-01-01,Null,NULL"].join(
        "\n",
      ),
      "csv",
    );

    expect(users[0]).toMatchObject({ userId: "s2", lastName: "Null" });
    expect(users[0]).not.toHaveProperty("skipReason");
  });

  const base = { id: "sb1", email: "a@x.dev", email_confirmed_at: "2024-06-29 20:25:06.126079+00" };

  // Supabase accepts argon2 hashes on import, so the hasher is read per user.
  test.each([
    ["$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy", "bcrypt"],
    ["$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo", "argon2id"],
    ["$argon2i$v=19$m=4096,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo", "argon2i"],
  ])("detects the hasher for %p", (encrypted_password, hasher) => {
    const user = one("supabase", { ...base, encrypted_password });
    expect(user?.passwordHasher).toBe(hasher);
    expect(user?.password).toBe(encrypted_password);
  });

  test("drops a hash no hasher fits, and imports the user", () => {
    const user = one("supabase", { ...base, encrypted_password: "md5:abc" });
    expect(user?.password).toBeUndefined();
    expect(user?.passwordDropped).toBe(true);
  });

  test("skips a soft-deleted user", () => {
    const user = one("supabase", { ...base, deleted_at: "2026-01-01 00:00:00+00" });
    expect(user?.skipReason).toBe("deleted in Supabase");
    expect("deletedAt" in (user ?? {})).toBe(false);
  });

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

  // The hasher comes from each digest, so a user without one gets none. Loaded
  // from a file, because that is where source defaults are applied.
  test("gives a passwordless user no password hasher", async () => {
    const { users } = await load("supabase", [
      { id: "s1", email: "a@x.dev", encrypted_password: "" },
    ]);
    expect(users[0]).not.toHaveProperty("passwordHasher");
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

  // A CSV carries the metadata as JSON text.
  test("falls back to metadata given as JSON text, as a CSV carries it", () => {
    const user = one("supabase", {
      ...base,
      raw_user_meta_data: JSON.stringify({ display_name: "Ada Lovelace" }),
    });
    expect(user?.firstName).toBe("Ada");
  });

  test.each([
    ["an object", { first_name: "Mary Ann", last_name: "Doe" }],
    ["JSON text", JSON.stringify({ first_name: "Mary Ann", last_name: "Doe" })],
  ])("maps separate metadata name fields as-is, given as %s", (_, raw_user_meta_data) => {
    const user = one("supabase", { ...base, raw_user_meta_data });
    expect(user?.firstName).toBe("Mary Ann");
    expect(user?.lastName).toBe("Doe");
  });

  // Supabase's own social logins write `full_name`.
  test("splits a metadata full_name", () => {
    const user = one("supabase", { ...base, raw_user_meta_data: { full_name: "Ada Lovelace" } });
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

// The Dashboard's CSV prefixes a TAB to a value a spreadsheet would run as a
// formula (clerk_go pkg/csvsafe).
describe("clerk", () => {
  test.each([
    ["\t=Ada", "=Ada"],
    ["\t@ada", "@ada"],
    ["\t＋Ada", "＋Ada"],
    ["\tAda", "\tAda"],
  ])("first name %p imports as %p", (firstName, expected) => {
    expect(
      one("clerk", { id: "u1", primary_email_address: "a@x.dev", first_name: firstName })
        ?.firstName,
    ).toBe(expected);
  });

  test("unprefixes each address in a list", () => {
    const user = one("clerk", {
      id: "u1",
      primary_email_address: "a@x.dev",
      unverified_email_addresses: "\t-b@x.dev",
    });
    expect(user?.unverifiedEmailAddresses).toEqual(["-b@x.dev"]);
  });

  // The TAB has to come off before the primary is matched against the lists,
  // or a phone is sent twice, or an unverified one is created verified.
  test("a prefixed phone that is primary and verified is one phone", () => {
    const user = one("clerk", {
      id: "u1",
      primary_phone_number: "\t+15555550100",
      verified_phone_numbers: "\t+15555550100",
    });
    expect(user?.phone).toEqual(["+15555550100"]);
  });

  test("a prefixed primary phone listed as unverified stays unverified", () => {
    const user = one("clerk", {
      id: "u1",
      primary_email_address: "a@x.dev",
      primary_phone_number: "\t+15555550100",
      unverified_phone_numbers: "\t+15555550100",
    });
    expect(user?.phone).toBeUndefined();
    expect(user?.unverifiedPhoneNumbers).toEqual(["+15555550100"]);
  });

  // The schema accepts an array for a primary identifier, so it must not throw.
  test("reads a primary email given as an array", () => {
    const user = one("clerk", {
      id: "u1",
      primary_email_address: [" a@x.dev ", "b@x.dev"],
      verified_email_addresses: ["b@x.dev"],
    });
    expect(user?.email).toEqual(["a@x.dev", "b@x.dev"]);
  });

  test("an array primary listed as unverified stays unverified", () => {
    const user = one("clerk", {
      id: "u1",
      primary_phone_number: ["+15555550100"],
      primary_email_address: "a@x.dev",
      unverified_phone_numbers: [" +15555550100 "],
    });
    expect(user?.phone).toBeUndefined();
    expect(user?.unverifiedPhoneNumbers).toEqual(["+15555550100"]);
  });

  test("a prefixed primary email listed as unverified stays unverified", () => {
    const user = one("clerk", {
      id: "u1",
      primary_email_address: "\t+a@x.dev",
      unverified_email_addresses: "\t+a@x.dev",
    });
    expect(user?.email).toBeUndefined();
    expect(user?.unverifiedEmailAddresses).toEqual(["+a@x.dev"]);
  });
});

// The CLI's own exports add these; reporting them as "Clerk won't store" on
// every import would be noise about the CLI itself.
describe("fields the CLI's own export adds", () => {
  test.each([
    [
      "supabase",
      {
        id: "s1",
        email: "a@x.dev",
        email_confirmed_at: "2024-01-01",
        raw_app_meta_data: { providers: ["email"] },
      },
    ],
  ])("%s reports no unknown fields", async (key, record) => {
    const { unknownFields } = await load(key, [record]);
    expect(unknownFields).toEqual({});
  });
});

describe("invalid records", () => {
  const INVALID: [string, Record<string, unknown>][] = [["supabase", { id: "a5" }]];

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
});

/** The per-platform source field that becomes a Clerk identifier. */
function identifierFor(_key: string, email = "ok@x.dev"): Record<string, unknown> {
  return { email, email_confirmed_at: "2024-01-01 00:00:00+00" };
}
