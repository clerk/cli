import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { UserSettingsJSON } from "../../../lib/fapi.ts";
import type { User } from "../types.ts";
import { checkImport, hashShapeProblem, passwordIsOnlySignIn, type CheckInput } from "./checks.ts";

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
    // BAPI strips the `+` the lookup puts on each external_id.
    const wanted = new Set([...url.searchParams.values()].map((value) => value.replace(/^\+/, "")));
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
  // Each one is a user POST /v1/users refuses (clerk_go create_service.go).
  describe("what the create refuses", () => {
    const EMAIL_ON = { email_address: { enabled: true } };

    test.each([
      ["first_name", { lastName: "L" }, "no first name, which this instance requires"],
      ["last_name", { firstName: "F" }, "no last name, which this instance requires"],
    ] as const)("a missing required %s", async (attribute, fields, reason) => {
      const reasons = await reasonsOf({
        users: [user("a", fields), user("b", { firstName: "F", lastName: "L" })],
        settings: settings({ ...EMAIL_ON, [attribute]: { enabled: true, required: true } }),
      });
      expect(reasons).toEqual({ a: reason });
    });

    test.each([
      [
        "totpSecret",
        "authenticator_app",
        "has an authenticator app (TOTP) secret, and this instance has authenticator apps off",
      ],
      ["backupCodes", "backup_code", "has backup codes, and this instance has backup codes off"],
    ] as const)("%s with %s off, offering to turn it on", async (field, attribute, reason) => {
      const value = field === "backupCodes" ? ["code1"] : "SECRET";
      const checks = await checkImport(
        input({
          users: [user("a", { [field]: value })],
          settings: settings({ ...EMAIL_ON, [attribute]: { enabled: false } }),
        }),
      );
      expect(checks.rejects).toEqual([{ sourceId: "a", reason }]);
      expect(checks.fixes.map((fix) => fix.command).join("\n")).toContain(
        `"auth_multi_factor":{"${attribute}":{"enabled":true}}`,
      );
    });

    test("no password where password is the only way to sign in", async () => {
      const passwordOnly = settings({
        email_address: { enabled: true, used_for_first_factor: false, first_factors: [] },
        password: { enabled: true, used_for_first_factor: true, first_factors: ["password"] },
      });
      const reasons = await reasonsOf({
        users: [user("a"), user("b", { password: BCRYPT, passwordHasher: "bcrypt" })],
        settings: passwordOnly,
      });
      expect(reasons).toEqual({
        a: "no password, and password is this instance's only way to sign in",
      });
    });

    // Firebase or Supabase phone-auth users, into an instance with phone off.
    test("a user left with no identifier once disabled ones are stripped", async () => {
      const reasons = await reasonsOf({
        users: [user("phone-only", { email: undefined, phone: "+15555550100" }), user("b")],
        settings: settings({ email_address: { enabled: true }, phone_number: { enabled: false } }),
      });
      expect(reasons).toEqual({
        "phone-only":
          "has no identifier this instance accepts (its email, phone or username is turned off)",
      });
    });

    describe("legal consent", () => {
      const LEGAL = {
        ...settings(EMAIL_ON),
        sign_up: { legal_consent_enabled: true },
      } as unknown as UserSettingsJSON;
      const users = [user("a"), user("b", { legalAcceptedAt: "2024-01-01T00:00:00.000Z" })];

      test("rejects a user with no acceptance on record, naming the flag", async () => {
        expect((await reasonsOf({ users, settings: LEGAL })).a).toContain("--skip-legal-checks");
      });

      test("with skipLegalChecks, imports them with skip_legal_checks and a warning", async () => {
        const checks = await checkImport(input({ users, settings: LEGAL, skipLegalChecks: true }));
        expect(checks.rejects).toEqual([]);
        expect(checks.importable.map((u) => u.skipLegalChecks)).toEqual([true, undefined]);
        expect(checks.warnings.join("\n")).toContain("1 user has no legal acceptance on record");
      });
    });
  });

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
      b: "email is also used by an earlier user in the file, which is kept",
      d: "phone number is also used by an earlier user in the file, which is kept",
    });
  });

  // The source's order decides which duplicate survives, so the dry run says.
  test("a duplicate names the earlier user kept in its place", async () => {
    const checks = await checkImport(
      input({
        users: [user("email|1", { email: "a@x.dev" }), user("auth0|1", { email: "a@x.dev" })],
      }),
    );
    expect(checks.rejects).toEqual([
      {
        sourceId: "auth0|1",
        reason: "email is also used by an earlier user in the file, which is kept",
        keptSourceId: "email|1",
      },
    ]);
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

  // A continued run found this user behind its own in-flight create.
  test("not a user the continued run adopted", async () => {
    existing = [{ id: "user_1", external_id: "mine" }];

    expect(
      await reasonsOf({ users: [user("mine")], adoptedClerkIds: new Set(["user_1"]) }),
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
      {
        sourceId: "c",
        reason:
          "over the development instance's 100-user limit (raised by Clerk? set CLERK_MIGRATE_DEV_USER_LIMIT)",
      },
    ]);
    expect(checks.quota).toEqual({ existing: 98, limit: 100, headroom: 2, over: 1 });
  });

  test("CLERK_MIGRATE_DEV_USER_LIMIT raises the headroom", async () => {
    process.env.CLERK_MIGRATE_DEV_USER_LIMIT = "500";
    try {
      const checks = await checkImport(
        input({ instanceType: "dev", existingUsers: 98, users: [user("a"), user("b"), user("c")] }),
      );
      expect(checks.rejects).toEqual([]);
      expect(checks.quota).toEqual({ existing: 98, limit: 500, headroom: 402, over: 0 });
    } finally {
      delete process.env.CLERK_MIGRATE_DEV_USER_LIMIT;
    }
  });

  test("a user its source asked to skip, with the source's reason", async () => {
    const checks = await checkImport(
      input({ users: [user("a", { skipReason: "anonymous Better Auth user" }), user("b")] }),
    );
    expect(checks.rejects).toEqual([{ sourceId: "a", reason: "anonymous Better Auth user" }]);
    expect(checks.importable.map((entry) => entry.userId)).toEqual(["b"]);
  });

  describe("emails Clerk refuses", () => {
    test("a user whose only identifier is a placeholder email is rejected", async () => {
      const checks = await checkImport(
        input({ users: [user("a", { email: "15551234@phone.local" })] }),
      );
      expect(checks.rejects).toEqual([
        { sourceId: "a", reason: "only has an email Clerk refuses (15551234@phone.local)" },
      ]);
    });

    test("a placeholder email is dropped, and the user imports on what is left", async () => {
      const checks = await checkImport(
        input({
          users: [
            user("a", {
              email: "a@x.dev",
              unverifiedEmailAddresses: ["anon-1@anonymous.invalid"],
            }),
          ],
        }),
      );
      expect(checks.rejects).toEqual([]);
      expect(checks.importable).toEqual([user("a", { email: "a@x.dev" })]);
      expect(checks.warnings).toContain(
        "1 user has an email Clerk refuses (.local, .invalid, .test, .example, .arpa), which is dropped",
      );
    });

    test("Clerk's own .clerk.test addresses are kept", async () => {
      const checks = await checkImport(
        input({ users: [user("a", { email: "a@dev.clerk.test" })] }),
      );
      expect(checks.importable).toEqual([user("a", { email: "a@dev.clerk.test" })]);
    });
  });

  describe("names Clerk refuses", () => {
    test.each([
      ["+447836887904"],
      ["4165550123"],
      ["ada@x.dev"],
      ["https://spam.example"],
      ["see x.com/win"],
      ["<b>Ada</b>"],
    ])("%p is dropped, and the user still imports", async (firstName) => {
      const checks = await checkImport(input({ users: [user("a", { firstName, lastName: "L" })] }));
      expect(checks.rejects).toEqual([]);
      expect(checks.importable).toEqual([user("a", { lastName: "L" })]);
      expect(checks.warnings).toContain(
        "1 user has a name Clerk refuses (a phone number, email, URL or HTML), which is dropped",
      );
    });

    test.each([["Ada"], ["Mary-Jane O'Neil"], ["Louis XIV"], ["Agent 007"], ["redacted.io"]])(
      "%p is kept",
      async (firstName) => {
        const checks = await checkImport(input({ users: [user("a", { firstName })] }));
        expect(checks.importable).toEqual([user("a", { firstName })]);
      },
    );
  });

  describe("usernames", () => {
    const withUsernames = (rules: object) =>
      ({
        attributes: { email_address: { enabled: true }, username: { enabled: true } },
        social: {},
        username_settings: { min_length: 4, max_length: 64, ...rules },
      }) as unknown as UserSettingsJSON;
    const reasonFor = async (username: string, rules: object = {}) =>
      (
        await checkImport(
          input({ settings: withUsernames(rules), users: [user("a", { username })] }),
        )
      ).rejects[0]?.reason;

    test.each([
      ["ada_l-1", {}],
      ["ada.l", { allow_extended_special_characters: true }],
    ])("%p is accepted", async (username, rules) => {
      expect(await reasonFor(username, rules)).toBeUndefined();
    });

    test("a . needs extended special characters", async () => {
      expect(await reasonFor("ada.lovelace")).toContain("turn on extended special characters");
    });

    test.each([
      ["ada", "4–64 characters"],
      ["12345", "no letters"],
      ["ada@x", "characters Clerk does not allow"],
    ])("%p is rejected: %s", async (username, reason) => {
      expect(await reasonFor(username)).toContain(reason);
    });

    test("a username is not checked when usernames are off", async () => {
      const checks = await checkImport(
        input({ settings: EMAIL_REQUIRED, users: [user("a", { username: "a.b" })] }),
      );
      expect(checks.rejects).toEqual([]);
    });
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

  // Clerk refuses the whole create when it is sent an identifier the instance
  // has off, so the dropped phone has to actually be dropped.
  test("strips identifiers the instance has off from the importable users", async () => {
    const checks = await checkImport(
      input({
        settings: settings({ email_address: { enabled: true }, phone_number: { enabled: false } }),
        users: [
          user("a", {
            phone: "+15555550100",
            unverifiedPhoneNumbers: ["+15555550101"],
            username: "ada.l",
          }),
        ],
      }),
    );
    expect(checks.importable).toEqual([user("a")]);
  });

  test("says a password is kept, not dropped, when passwords are off", async () => {
    const checks = await checkImport(
      input({
        settings: settings({ email_address: { enabled: true }, password: { enabled: false } }),
        users: [user("a", { password: BCRYPT, passwordHasher: "bcrypt" })],
      }),
    );
    expect(checks.warnings).toContain(
      "1 user has a password, which this instance does not use: it is stored, and works only once passwords are turned on",
    );
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

describe("passwordIsOnlySignIn", () => {
  const withFactors = (factors: Record<string, string[]>, social: object = {}) =>
    settings(
      Object.fromEntries(
        Object.entries(factors).map(([name, first_factors]) => [
          name,
          { enabled: true, used_for_first_factor: first_factors.length > 0, first_factors },
        ]),
      ),
      social,
    );

  test.each([
    ["password alone", { password: ["password"] }, {}, true],
    // Mirrors clerk_go: a passkey is not counted as a way in without a password.
    ["password and passkey", { password: ["password"], passkey: ["passkey"] }, {}, true],
    [
      "password and email codes",
      { password: ["password"], email_address: ["email_code"] },
      {},
      false,
    ],
    [
      "password and Google",
      { password: ["password"] },
      { oauth_google: { enabled: true, authenticatable: true } },
      false,
    ],
    ["no password factor", { email_address: ["email_code"] }, {}, false],
  ])("%s -> %p", (_label, factors, social, expected) => {
    expect(passwordIsOnlySignIn(withFactors(factors, social))).toBe(expected);
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
