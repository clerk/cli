import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "../../../lib/errors.ts";
import clerkSource from "../sources/clerk.ts";
import { __resetCustomSourcesForTesting, registerCustomSource } from "../sources/registry.ts";
import {
  consolidateClerkIdentifiers,
  flattenObjectSelectively,
  getFileType,
  loadUsersFromFile,
  normalizeUserData,
  transformKeys,
  transformUsers,
  validatePreparedUsers,
} from "./transform.ts";

let workDir: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-transform-"));
  process.chdir(workDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("getFileType", () => {
  test.each([
    ["users.json", "application/json"],
    ["users.CSV", "text/csv"],
    ["users.ndjson", "application/json"],
    ["users.jsonl", "application/json"],
    ["users.txt", undefined],
    ["users", undefined],
  ])("%s -> %p", (file, expected) => {
    expect(getFileType(file)).toBe(expected as never);
  });
});

describe("flattenObjectSelectively", () => {
  test("flattens only paths the transformer references", () => {
    const result = flattenObjectSelectively(
      { _id: { $oid: "123" }, meta: { keep: "nested" }, email: "a@example.com" },
      { "_id.$oid": "userId", email: "email" },
    );
    expect(result).toEqual({
      "_id.$oid": "123",
      meta: { keep: "nested" },
      email: "a@example.com",
    });
  });

  test("leaves arrays intact", () => {
    expect(flattenObjectSelectively({ tags: [{ a: 1 }] }, { "tags.a": "x" })).toEqual({
      tags: [{ a: 1 }],
    });
  });
});

describe("transformKeys", () => {
  test("renames mapped fields and passes unmapped ones through", () => {
    expect(
      transformKeys(
        { id: "u1", primary_email_address: "a@example.com", extra: "kept" },
        clerkSource,
      ),
    ).toEqual({ userId: "u1", email: "a@example.com", extra: "kept" });
  });

  test.each([
    ["empty string", ""],
    ["stringified empty object", '"{}"'],
    ["null", null],
  ])("drops fields whose value is %s", (_label, value) => {
    expect(transformKeys({ id: "u1", first_name: value }, clerkSource)).toEqual({
      userId: "u1",
    });
  });
});

describe("normalizeUserData", () => {
  test.each([
    ["comma-delimited emails", { email: "a@x.dev,b@x.dev" }, { email: ["a@x.dev", "b@x.dev"] }],
    ["pipe-delimited emails", { email: "a@x.dev|b@x.dev" }, { email: ["a@x.dev", "b@x.dev"] }],
    ["JSON array string", { email: '["a@x.dev"]' }, { email: ["a@x.dev"] }],
    ["string boolean", { banned: "true" }, { banned: true }],
    ["numeric boolean", { banned: 1 }, { banned: true }],
    ["numeric string limit", { createOrganizationsLimit: "5" }, { createOrganizationsLimit: 5 }],
    ["JSON metadata", { publicMetadata: '{"plan":"pro"}' }, { publicMetadata: { plan: "pro" } }],
    ["date string", { createdAt: "2024-01-01" }, { createdAt: "2024-01-01T00:00:00.000Z" }],
    ["numeric user ID", { userId: 42 }, { userId: "42" }],
    ["epoch milliseconds", { createdAt: 1704067200000 }, { createdAt: "2024-01-01T00:00:00.000Z" }],
    // As milliseconds this would be January 1970.
    ["epoch seconds", { createdAt: 1704067200 }, { createdAt: "2024-01-01T00:00:00.000Z" }],
  ])("normalizes %s", (_label, input, expected) => {
    expect(normalizeUserData(input)).toMatchObject(expected);
  });

  test("deletes fields that normalize to nothing", () => {
    const result = normalizeUserData({ email: "  ", publicMetadata: "", createdAt: "" });
    expect("email" in result).toBe(false);
    expect("publicMetadata" in result).toBe(false);
    expect("createdAt" in result).toBe(false);
  });

  test("leaves an unparseable date as-is for the schema to reject", () => {
    expect(normalizeUserData({ createdAt: "yesterday" }).createdAt).toBe("yesterday");
  });
});

describe("consolidateClerkIdentifiers", () => {
  test("merges primary and verified emails, deduping", () => {
    const user: Record<string, unknown> = {
      email: "a@x.dev",
      emailAddresses: ["a@x.dev", "b@x.dev"],
      unverifiedEmailAddresses: ["b@x.dev", "c@x.dev"],
    };
    consolidateClerkIdentifiers(user);
    expect(user.email).toEqual(["a@x.dev", "b@x.dev"]);
    expect(user.emailAddresses).toBeUndefined();
    // b@x.dev is already verified, so it must not reappear as unverified.
    expect(user.unverifiedEmailAddresses).toEqual(["c@x.dev"]);
  });

  test("drops the unverified list when every entry is already verified", () => {
    const user: Record<string, unknown> = {
      phone: "+15555550100",
      phoneNumbers: ["+15555550101"],
      unverifiedPhoneNumbers: ["+15555550101"],
    };
    consolidateClerkIdentifiers(user);
    expect(user.phone).toEqual(["+15555550100", "+15555550101"]);
    expect("unverifiedPhoneNumbers" in user).toBe(false);
  });

  // The Dashboard lists an unverified primary under unverified_email_addresses.
  test.each([
    ["email", "unverifiedEmailAddresses", "a@x.dev"],
    ["phone", "unverifiedPhoneNumbers", "+15555550100"],
  ])("keeps an unverified primary %s unverified", (primaryKey, unverifiedKey, value) => {
    const user: Record<string, unknown> = { [primaryKey]: value, [unverifiedKey]: [value] };
    consolidateClerkIdentifiers(user);
    expect(primaryKey in user).toBe(false);
    expect(user[unverifiedKey]).toEqual([value]);
  });
});

describe("validatePreparedUsers", () => {
  test("keeps valid users and counts the rest", () => {
    const result = validatePreparedUsers([
      { userId: "u1", email: "a@x.dev" },
      { userId: "u2" },
      { userId: "u3", username: "carol" },
    ]);
    expect(result.users.map((user) => user.userId)).toEqual(["u1", "u3"]);
    expect(result.validationFailed).toBe(1);
    expect(result.failures).toMatchObject([{ userId: "u2", row: 1 }]);
  });

  test("aborts the whole run on an unknown password hasher", () => {
    expect(() =>
      validatePreparedUsers([
        { userId: "u1", email: "a@x.dev", password: "d", passwordHasher: "rot13" },
      ]),
    ).toThrow(CliError);
  });
});

describe("transformUsers", () => {
  test("maps, consolidates and validates a Clerk export", () => {
    const { transformedData, validationFailed } = transformUsers(
      [
        {
          id: "u1",
          primary_email_address: "a@x.dev",
          verified_email_addresses: ["a@x.dev", "b@x.dev"],
          first_name: "Alice",
        },
      ],
      "clerk",
    );
    expect(validationFailed).toBe(0);
    expect(transformedData[0]).toMatchObject({
      userId: "u1",
      email: ["a@x.dev", "b@x.dev"],
      firstName: "Alice",
    });
  });

  test("skips validation when asked, so analysis passes see every row", () => {
    const { transformedData, validationFailed } = transformUsers([{ id: "u1" }], "clerk", {
      validate: false,
    });
    expect(transformedData).toHaveLength(1);
    expect(validationFailed).toBe(0);
  });
});

describe("loadUsersFromFile", () => {
  test("reads a JSON export", async () => {
    fs.writeFileSync(
      path.join(workDir, "users.json"),
      JSON.stringify([{ id: "u1", primary_email_address: "a@x.dev" }]),
    );
    const { users } = await loadUsersFromFile("users.json", "clerk");
    expect(users).toHaveLength(1);
    expect(users[0]?.userId).toBe("u1");
  });

  test("reads a CSV export, including quoted commas", async () => {
    fs.writeFileSync(
      path.join(workDir, "users.csv"),
      'id,primary_email_address,verified_email_addresses\nu2,a@x.dev,"a@x.dev,b@x.dev"\n',
    );
    const { users } = await loadUsersFromFile("users.csv", "clerk");
    expect(users[0]?.userId).toBe("u2");
    expect(users[0]?.email).toEqual(["a@x.dev", "b@x.dev"]);
  });

  // Excel's "CSV UTF-8" starts with a BOM, which hid the first column.
  test("reads a CSV that starts with a BOM", async () => {
    fs.writeFileSync(path.join(workDir, "bom.csv"), "\uFEFFid,primary_email_address\nu3,a@x.dev\n");
    const { users } = await loadUsersFromFile("bom.csv", "clerk");
    expect(users[0]?.userId).toBe("u3");
  });

  test("reads a JSON file that starts with a BOM", async () => {
    fs.writeFileSync(
      path.join(workDir, "bom.json"),
      `\uFEFF${JSON.stringify([{ id: "u4", primary_email_address: "a@x.dev" }])}`,
    );
    const { users } = await loadUsersFromFile("bom.json", "clerk");
    expect(users[0]?.userId).toBe("u4");
  });

  // What Auth0's bulk export job writes, for tenants over 1,000 users.
  test.each([["users-bulk.json"], ["users-bulk.ndjson"]])("reads NDJSON from %s", async (file) => {
    fs.writeFileSync(
      path.join(workDir, file),
      '{"id":"u5","primary_email_address":"a@x.dev"}\n{"id":"u6","primary_email_address":"b@x.dev"}\n',
    );
    const { users } = await loadUsersFromFile(file, "clerk");
    expect(users.map((user) => user.userId)).toEqual(["u5", "u6"]);
  });

  test("names the file when it is not valid JSON", async () => {
    fs.writeFileSync(path.join(workDir, "broken.json"), "[{");
    const error = (await loadUsersFromFile("broken.json", "clerk").catch(
      (e: unknown) => e,
    )) as CliError;
    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toContain("broken.json is not valid JSON");
  });

  // `#` starts a value, not a comment: dropping the row would lose the user
  // and record nothing.
  test("keeps a CSV row whose first cell starts with #", async () => {
    fs.writeFileSync(path.join(workDir, "hash.csv"), "id,primary_email_address\n#7,a@x.dev\n");
    const { users } = await loadUsersFromFile("hash.csv", "clerk");
    expect(users.map((user) => user.userId)).toEqual(["#7"]);
  });

  test("a custom preTransform's rows win over a CSV file", async () => {
    registerCustomSource({
      ...clerkSource,
      key: "rows-from-pretransform",
      preTransform: (filePath) => ({
        filePath,
        data: [{ id: "from-pretransform", primary_email_address: "p@x.dev" }],
      }),
    });
    try {
      fs.writeFileSync(
        path.join(workDir, "ignored.csv"),
        "id,primary_email_address\nfile,f@x.dev\n",
      );
      const { users } = await loadUsersFromFile("ignored.csv", "rows-from-pretransform");
      expect(users.map((user) => user.userId)).toEqual(["from-pretransform"]);
    } finally {
      __resetCustomSourcesForTesting();
    }
  });

  test("rejects a JSON file that is not an array of users", async () => {
    fs.writeFileSync(path.join(workDir, "wrapped.json"), JSON.stringify({ users: [] }));
    await expect(loadUsersFromFile("wrapped.json", "clerk")).rejects.toThrow(CliError);
  });
});
