import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { UserSettingsJSON } from "../../../lib/fapi.ts";
import type { User } from "../types.ts";
import { checkImport, hashShapeProblem, type CheckInput } from "./checks.ts";

const BCRYPT = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

const settings = (attributes: object, social: object = {}) =>
  ({ attributes, social }) as unknown as UserSettingsJSON;

const EMAIL_REQUIRED = settings({ email_address: { enabled: true, required: true } });

const user = (userId: string, fields: Partial<User> = {}): User =>
  ({ userId, email: `${userId}@x.dev`, ...fields }) as User;

let originalFetch: typeof globalThis.fetch;
/** Users `GET /v1/users` finds, whatever the filter. */
let existing: Record<string, unknown>[];

beforeAll(() => {
  originalFetch = globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  existing = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    const wanted = new Set(url.searchParams.values());
    return Response.json(
      existing.filter((candidate) =>
        [
          candidate.external_id,
          candidate.username,
          ...((candidate.email_addresses as { email_address: string }[] | undefined) ?? []).map(
            (email) => email.email_address,
          ),
        ].some((value) => wanted.has(value as string)),
      ),
    );
  }) as typeof fetch;
});

function input(overrides: Partial<CheckInput> = {}): CheckInput {
  return {
    users: [],
    failures: [],
    settings: null,
    instanceType: "prod",
    target: {
      env: "production",
      instanceId: "ins_1",
      instanceType: "prod",
      keySource: "--secret-key",
    },
    secretKey: "sk_live_x",
    schedule: async (fn) => fn(),
    ...overrides,
  };
}

const reasonsOf = async (overrides: Partial<CheckInput>) =>
  Object.fromEntries(
    (await checkImport(input(overrides))).rejects.map((reject) => [reject.sourceId, reject.reason]),
  );

describe("rejects", () => {
  test("a user that failed validation", async () => {
    const checks = await checkImport(
      input({ failures: [{ userId: "bad", row: 0, error: "Invalid email", path: ["email"] }] }),
    );
    expect(checks.rejects).toEqual([{ sourceId: "bad", reason: "invalid: Invalid email" }]);
    expect(checks.total).toBe(1);
  });

  test("a duplicate source ID, email or phone within the file", async () => {
    expect(
      await reasonsOf({
        users: [
          user("a"),
          user("a", { email: "other@x.dev" }),
          user("b", { email: "A@x.dev" }),
          user("c", { phone: "+15555550100" }),
          user("d", { phone: "+15555550100" }),
        ],
      }),
    ).toEqual({
      a: "duplicate source ID in the file",
      b: "email is also used by another user in the file",
      d: "phone number is also used by another user in the file",
    });
  });

  // G20: an unverified email is attached after the user exists, so it cannot
  // satisfy a sign-up requirement.
  test("a user with only an unverified email, where email is required", async () => {
    expect(
      await reasonsOf({
        settings: EMAIL_REQUIRED,
        users: [
          user("ok"),
          user("unverified", { email: undefined, unverifiedEmailAddresses: ["u@x.dev"] }),
          user("none", { email: undefined, username: "none" }),
        ],
      }),
    ).toEqual({
      unverified: "only has an unverified email, and this instance requires an email",
      none: "no email, which this instance requires",
    });
  });

  test("a password that is not the shape its hasher says", async () => {
    expect(
      await reasonsOf({
        users: [
          user("good", { password: BCRYPT, passwordHasher: "bcrypt" }),
          user("bad", { password: "not-a-hash", passwordHasher: "bcrypt" }),
        ],
      }),
    ).toEqual({ bad: "password is not a bcrypt hash ($2a$/$2b$/$2y$, 60 characters)" });
  });

  test("a user already in the instance, by source ID, email or username", async () => {
    existing = [
      { id: "user_1", external_id: "by-id" },
      { id: "user_2", email_addresses: [{ email_address: "by-email@x.dev" }] },
      { id: "user_3", username: "taken" },
    ];

    expect(
      await reasonsOf({
        users: [
          user("by-id"),
          user("by-email"),
          user("by-username", { username: "Taken" }),
          user("new"),
        ],
      }),
    ).toEqual({
      "by-id": "already in the instance, with this source ID",
      "by-email": "email is already used by a user in the instance",
      "by-username": "username is already taken in the instance",
    });
  });

  // Continuing a run finds the users it created: that is expected, not a clash.
  test("not a user the run being continued created", async () => {
    existing = [{ id: "user_1", external_id: "mine" }];

    expect(
      await reasonsOf({ users: [user("mine")], continuedClerkIds: new Set(["user_1"]) }),
    ).toEqual({});
  });

  test("a supabase user whose only provider is disabled", async () => {
    const rows = [
      { id: "only-discord", raw_app_meta_data: { providers: ["discord"] } },
      { id: "has-email", raw_app_meta_data: { providers: ["email", "discord"] } },
    ];
    expect(
      await reasonsOf({
        settings: settings(
          { email_address: { enabled: true } },
          { oauth_google: { enabled: true } },
        ),
        supabaseRows: rows,
        users: [user("only-discord"), user("has-email")],
      }),
    ).toEqual({ "only-discord": "only signs in with Discord, which is not enabled in Clerk" });
  });

  test("the users past a development instance's headroom, in file order", async () => {
    const checks = await checkImport(
      input({
        instanceType: "dev",
        existingUsers: 98,
        users: [user("a"), user("b"), user("c")],
      }),
    );
    expect(checks.importable.map((entry) => entry.userId)).toEqual(["a", "b"]);
    expect(checks.rejects).toEqual([
      { sourceId: "c", reason: "over the development instance's 100-user limit" },
    ]);
    expect(checks.quota).toEqual({ existing: 98, limit: 100, headroom: 2, over: 1 });
  });

  test("groups the rejects by reason", async () => {
    const checks = await checkImport(
      input({
        settings: EMAIL_REQUIRED,
        users: [
          user("a", { email: undefined, username: "a" }),
          user("b", { email: undefined, username: "b" }),
        ],
      }),
    );
    expect(checks.rejectReasons).toEqual([
      { reason: "no email, which this instance requires", count: 2 },
    ]);
  });
});

describe("warnings", () => {
  test("a field the instance is not set up to store", async () => {
    const checks = await checkImport(
      input({
        settings: settings({ email_address: { enabled: true }, phone_number: { enabled: false } }),
        users: [user("a", { phone: "+15555550100" })],
      }),
    );
    expect(checks.warnings).toContain(
      "1 user has a phone, which this instance is not set up to store",
    );
    expect(checks.rejects).toEqual([]);
  });

  test("fields Clerk has no place for", async () => {
    const checks = await checkImport(
      input({ users: [user("a")], unknownFields: { department: 3, role: 1 } }),
    );
    expect(checks.warnings).toContain("Clerk won't store: department (3 users), role (1 user)");
  });

  test("passwords a source had to drop", async () => {
    const checks = await checkImport(input({ users: [user("a", { passwordDropped: true })] }));
    expect(checks.warnings[0]).toContain("1 password Clerk cannot verify will be dropped");
  });
});

describe("fixes", () => {
  test("print a `clerk config patch` per flagged setting, targeting the instance", async () => {
    const checks = await checkImport(
      input({
        settings: settings({
          email_address: { enabled: true, required: true },
          username: { enabled: true },
        }),
        target: {
          env: "production",
          appId: "app_1",
          instanceId: "ins_1",
          instanceType: "prod",
          keySource: "linked profile",
        },
        users: [user("a"), user("b", { email: undefined, username: "b" })],
      }),
    );
    expect(checks.fixes).toEqual([
      {
        label: "Make Email optional at sign-up",
        command: `clerk config patch --app app_1 --instance ins_1 --json '{"auth_email":{"required_for_sign_up":false}}'`,
      },
    ]);
  });

  test("offer nothing when the settings could not be read", async () => {
    const checks = await checkImport(input({ users: [user("a")] }));
    expect(checks.fixes).toEqual([]);
    expect(checks.settingsUnavailable).toBe(true);
  });
});

describe("hashShapeProblem", () => {
  test.each([
    [BCRYPT, "bcrypt"],
    ["hash$salt$signer$sep$8$14", "scrypt_firebase"],
    ["$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA", "argon2id"],
    [`scrypt:16384:16:1$${"a".repeat(32)}$${"b".repeat(128)}`, "scrypt_werkzeug"],
    // Not checked: a bad digest there fails only at sign-in.
    ["anything", "pbkdf2_sha256"],
  ])("accepts %s as %s", (password, hasher) => {
    expect(hashShapeProblem(password, hasher)).toBeUndefined();
  });

  test.each([
    ["$2a$10$short", "bcrypt"],
    ["hash$salt$signer$sep$eight$14", "scrypt_firebase"],
    ["hash$salt", "scrypt_firebase"],
    ["argon2id$...", "argon2id"],
    ["scrypt:16384:16:1$salt$not-hex!", "scrypt_werkzeug"],
  ])("rejects %s as %s", (password, hasher) => {
    expect(hashShapeProblem(password, hasher)).toBeDefined();
  });
});
