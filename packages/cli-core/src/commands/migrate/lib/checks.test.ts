import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { UserSettingsJSON } from "../../../lib/fapi.ts";
import type { User } from "../types.ts";
import { checkImport, hashShapeProblem, passwordIsOnlySignIn, type CheckInput } from "./checks.ts";

const BCRYPT = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

/** Settings as given, with no way to sign in but what they list. */
const bare = (attributes: object, social: object = {}) =>
  ({ attributes, social }) as unknown as UserSettingsJSON;

/**
 * Settings with a way to sign in besides a password (SSO), so users without
 * one import: Clerk refuses them on an instance with no other way in.
 */
const settings = (attributes: object, social: object = {}) =>
  ({ ...bare(attributes, social), enterprise_sso: { enabled: true } }) as UserSettingsJSON;

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
    schedule: Object.assign(async <T>(fn: () => Promise<T>) => fn(), { pause: () => {} }),
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
      const passwordOnly = bare({
        email_address: { enabled: true, used_for_first_factor: false, first_factors: [] },
        // Clerk's real shape: a password is never itself a listed first factor.
        password: { enabled: true, used_for_first_factor: false, first_factors: [] },
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
          "has no identifier this instance accepts (its email or phone is turned off, or its username is one Clerk refuses)",
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

  test("a duplicate source ID, email, phone or username within the file", async () => {
    expect(
      await reasonsOf({
        users: [
          user("a"),
          user("a", { email: "other@x.dev" }),
          user("b", { email: "A@x.dev" }),
          user("c", { phone: "+15555550100" }),
          user("d", { phone: "+15555550100" }),
          // The same number, punctuated.
          user("f", { phone: "+1 555-555-0100" }),
          user("g", { username: "Ada" }),
          // Clerk lowercases usernames.
          user("h", { username: "ada" }),
        ],
      }),
    ).toEqual({
      a: "duplicate source ID in the file",
      b: "email is also used by an earlier user in the file, which is kept",
      d: "phone number is also used by an earlier user in the file, which is kept",
      f: "phone number is also used by an earlier user in the file, which is kept",
      h: "username is also used by an earlier user in the file, which is kept",
    });
  });

  // Only what the create carries can clash: an extra email is attached after
  // it, and a clash there is a note on the user, not a failure.
  test("an extra email or phone shared with an earlier user is no duplicate", async () => {
    expect(
      await reasonsOf({
        users: [
          user("a", {
            emailAddresses: ["shared@x.dev"],
            phone: ["+15555550101", "+15555550100"],
          }),
          user("b", {
            emailAddresses: ["shared@x.dev"],
            phone: ["+15555550102", "+15555550100"],
          }),
        ],
      }),
    ).toEqual({});
  });

  // A stripped email never goes out, so it cannot clash with anything.
  test("an email the instance would strip is no duplicate", async () => {
    existing = [{ id: "user_1", email_addresses: [{ email_address: "taken@x.dev" }] }];
    const users = [
      user("a", { email: "same@x.dev", username: "a" }),
      user("b", { email: "same@x.dev", username: "b" }),
      user("c", { email: "taken@x.dev", username: "c" }),
    ];
    const checks = await checkImport(
      input({ users, settings: settings({ username: { enabled: true } }) }),
    );
    expect(checks.rejects).toEqual([]);
    expect(checks.importable.map((u) => [u.userId, u.email])).toEqual([
      ["a", undefined],
      ["b", undefined],
      ["c", undefined],
    ]);
    // The warning still describes the file: the emails are dropped.
    expect(checks.warnings.join("\n")).toContain(
      "3 users have an email, which this instance is not set up to store",
    );
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
    ).toEqual({
      bad: "password is not a bcrypt hash Clerk can verify ($2a$/$2b$/$2y$, cost 4 to 15, 60 characters)",
    });
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

  // A repeated record (an export that paged past a sign-up) must not take the
  // kept copy down with it.
  test("a repeated source ID rejects only the later copy", async () => {
    const checks = await checkImport(input({ users: [user("a"), user("a")] }));
    expect(checks.importable.map((u) => u.userId)).toEqual(["a"]);
    expect(checks.rejects).toEqual([{ sourceId: "a", reason: "duplicate source ID in the file" }]);
  });

  test("a rejected user does not claim its email from a later one", async () => {
    const checks = await checkImport(
      input({
        users: [
          user("skipped", { email: "same@x.dev", skipReason: "anonymous Better Auth user" }),
          user("kept", { email: "same@x.dev" }),
        ],
      }),
    );
    expect(checks.importable.map((u) => u.userId)).toEqual(["kept"]);
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

  // A disabled provider strands only a user with no other way in.
  test("a supabase user on a disabled provider who can sign in by email or phone code", async () => {
    const rows = [
      { id: "email", raw_app_meta_data: { providers: ["discord"] } },
      { id: "phone", raw_app_meta_data: { providers: ["discord"] } },
      { id: "neither", raw_app_meta_data: { providers: ["discord"] } },
    ];
    expect(
      await reasonsOf({
        settings: settings({
          email_address: {
            enabled: true,
            used_for_first_factor: true,
            first_factors: ["email_code"],
          },
          phone_number: {
            enabled: true,
            used_for_first_factor: true,
            first_factors: ["phone_code"],
          },
          username: { enabled: true },
        }),
        supabaseRows: rows,
        users: [
          user("email"),
          user("phone", { email: undefined, phone: "+15555550100" }),
          user("neither", { email: undefined, username: "neither" }),
        ],
      }),
    ).toEqual({ neither: "only signs in with Discord, which is not enabled in Clerk" });
  });

  test("an unverified email is no way in for a supabase user on a disabled provider", async () => {
    expect(
      await reasonsOf({
        settings: settings({
          email_address: {
            enabled: true,
            used_for_first_factor: true,
            first_factors: ["email_link"],
          },
        }),
        supabaseRows: [{ id: "u", raw_app_meta_data: { providers: ["discord"] } }],
        users: [user("u", { email: undefined, unverifiedEmailAddresses: ["u@x.dev"] })],
      }),
    ).toEqual({ u: "only signs in with Discord, which is not enabled in Clerk" });
  });

  // Clerk can't turn on a provider it doesn't offer, so none is suggested.
  test("a provider Clerk doesn't offer is named as such, with no fix", async () => {
    const rows = [
      { id: "figma", raw_app_meta_data: { providers: ["figma"] } },
      { id: "both", raw_app_meta_data: { providers: ["discord", "figma"] } },
    ];
    const checks = await checkImport(
      input({
        settings: settings({ email_address: { enabled: true } }),
        supabaseRows: rows,
        users: [user("figma"), user("both")],
      }),
    );
    expect(Object.fromEntries(checks.rejects.map((r) => [r.sourceId, r.reason]))).toEqual({
      figma: "only signs in with Figma, which is not offered by Clerk",
      both: "only signs in with Discord (not enabled in Clerk), Figma (not offered by Clerk)",
    });
    expect(checks.fixes.map((fix) => fix.label)).not.toContain("Enable Figma sign-in");
  });

  // Each reject names that user's providers, not every disabled one in the file.
  test("a supabase reject names only that user's own providers", async () => {
    const rows = [
      { id: "discord", raw_app_meta_data: { providers: ["discord"] } },
      { id: "twitch", raw_app_meta_data: { providers: ["twitch"] } },
    ];
    expect(
      await reasonsOf({
        settings: settings({ email_address: { enabled: true } }),
        supabaseRows: rows,
        users: [user("discord"), user("twitch")],
      }),
    ).toEqual({
      discord: "only signs in with Discord, which is not enabled in Clerk",
      twitch: "only signs in with Twitch, which is not enabled in Clerk",
    });
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

  test("warns that an unreadable user count was checked as empty", async () => {
    const checks = await checkImport(
      input({ instanceType: "dev", existingUsers: null, users: [user("a")] }),
    );
    expect(checks.warnings.join("\n")).toContain("Could not read how many users");
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
      // One fixed reason, so these group in the report and the address
      // itself stays out of users.ndjson.
      expect(checks.rejects).toEqual([
        {
          sourceId: "a",
          reason: "only has emails Clerk refuses (malformed, or a domain that can't receive mail)",
        },
      ]);
    });

    test.each([
      ["a@localhost", "no dotted domain"],
      ["not-an-email", "no @"],
      ["a b@x.dev", "a space"],
      ["ada@corp.internal", "a private TLD"],
    ])("drops %p (%s) and keeps the user on its other email", async (bad) => {
      const checks = await checkImport(
        input({ users: [user("a", { email: "a@x.dev", emailAddresses: [bad] })] }),
      );
      expect(checks.rejects).toEqual([]);
      expect(checks.importable[0]?.emailAddresses).toBeUndefined();
    });

    // clerk_go accepts a non-ASCII local part; Zod's email check did not.
    test("keeps a non-ASCII address", async () => {
      const checks = await checkImport(input({ users: [user("a", { email: "josé@x.dev" })] }));
      expect(checks.importable).toEqual([user("a", { email: "josé@x.dev" })]);
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
        "1 user has an email Clerk refuses (malformed, or a domain such as .local or .invalid), which is dropped",
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
      ["https://spam.example"],
      ["see x.com/win"],
      ["<b>Ada</b>"],
      ["   "],
      ["\u200b"],
      ["é".repeat(129)],
    ])("%p is dropped, and the user still imports", async (firstName) => {
      const checks = await checkImport(input({ users: [user("a", { firstName, lastName: "L" })] }));
      expect(checks.rejects).toEqual([]);
      expect(checks.importable).toEqual([user("a", { lastName: "L" })]);
      expect(checks.warnings).toContain(
        "1 user has a name Clerk refuses (a phone number, a URL, HTML, blank, or over 256 bytes), which is dropped",
      );
    });

    // Clerk accepts an email as a name, and a URL that is part of one.
    test.each([
      ["Ada"],
      ["Mary-Jane O'Neil"],
      ["Louis XIV"],
      ["Agent 007"],
      ["redacted.io"],
      ["ada@x.dev"],
      ["ada@x.dev/x"],
      // 256 bytes exactly.
      ["é".repeat(128)],
    ])("%p is kept", async (firstName) => {
      const checks = await checkImport(input({ users: [user("a", { firstName })] }));
      expect(checks.importable).toEqual([user("a", { firstName })]);
    });
  });

  describe("usernames", () => {
    const withUsernames = (rules: object) =>
      ({
        attributes: { email_address: { enabled: true }, username: { enabled: true } },
        social: {},
        enterprise_sso: { enabled: true },
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

    // Clerk checks a username with usernames off too, but nothing signs in
    // with it there, so it costs the user nothing to lose it.
    test("with usernames off, one Clerk would refuse is dropped, not rejected", async () => {
      const checks = await checkImport(
        input({ settings: EMAIL_REQUIRED, users: [user("a", { username: "a.b" })] }),
      );
      expect(checks.rejects).toEqual([]);
      expect(checks.importable).toEqual([user("a")]);
      expect(checks.warnings).toContain(
        "1 user has a username Clerk refuses, which is dropped: this instance has usernames off",
      );
    });

    // Clerk never checks whether usernames are on (create_service.go).
    test("with usernames off, a valid one is kept and said to be stored", async () => {
      const checks = await checkImport(
        input({ settings: EMAIL_REQUIRED, users: [user("a", { username: "ada" })] }),
      );
      expect(checks.importable).toEqual([user("a", { username: "ada" })]);
      expect(checks.warnings).toContain(
        "1 user has a username, which this instance does not use: it is stored, and works only once usernames are turned on",
      );
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
      "1 user has a phone number, which this instance is not set up to store",
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

  // Clerk keeps an email or phone the instance signs in or does MFA with,
  // whatever the sign-up setting (`IsEnabledOrFactor` in clerk_go).
  test.each([
    ["sign-in", { enabled: false, used_for_first_factor: true, first_factors: ["phone_code"] }],
    ["MFA", { enabled: false, used_for_second_factor: true, second_factors: ["phone_code"] }],
  ])("keeps a phone used only for %s, with no warning or fix", async (_label, phone_number) => {
    const phoneOnly = user("p", { email: undefined, phone: "+15555550100" });
    const checks = await checkImport(
      input({
        settings: settings({ email_address: { enabled: true }, phone_number }),
        users: [user("a", { phone: "+15555550101" }), phoneOnly],
      }),
    );
    expect(checks.rejects).toEqual([]);
    expect(checks.importable).toEqual([user("a", { phone: "+15555550101" }), phoneOnly]);
    expect(checks.warnings).toEqual([]);
    expect(checks.fixes).toEqual([]);
  });

  // Clerk validates a name but never checks its setting (create_service.go).
  test("says a name is kept, not dropped, when names are off", async () => {
    const checks = await checkImport(
      input({
        settings: settings({ email_address: { enabled: true }, first_name: { enabled: false } }),
        users: [user("a", { firstName: "Ada" })],
      }),
    );
    expect(checks.importable).toEqual([user("a", { firstName: "Ada" })]);
    expect(checks.warnings).toEqual([
      "1 user has a first name, which this instance does not use: it is stored, and shows only once first names are turned on",
    ]);
    expect(checks.fixes.map((fix) => fix.label)).toEqual(["Enable First name"]);
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

  // Clerk's ban has no end, so a source's temporary ban would outlast itself.
  test("a ban that was due to end", async () => {
    const checks = await checkImport(
      input({
        users: [
          user("a", { banned: true, banEndsAt: "2026-11-01T00:00:00.000Z" }),
          user("b", { banned: true, banEndsAt: "2026-12-01T00:00:00.000Z" }),
          user("c", { banned: true }),
        ],
      }),
    );
    expect(checks.warnings).toContain(
      "2 users have bans that end by 2026-12-01; Clerk's ban has no end, so they stay banned until unbanned in Clerk",
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

  // Without --instance, `clerk config patch` changes the linked profile's
  // development instance, not the one a --secret-key import targets; without
  // --app, the linked profile's app. A key names neither app nor profile.
  test("name the instance, and leave the app to fill in, when the key came from --secret-key", async () => {
    const checks = await checkImport(
      input({
        settings: EMAIL_REQUIRED,
        users: [user("b", { email: undefined, username: "b" })],
      }),
    );
    expect(checks.fixes[0]?.command).toStartWith(
      "clerk config patch --app APP_ID --instance ins_1 --json",
    );
  });

  test("point at the Dashboard when the instance could not be named", async () => {
    const checks = await checkImport(
      input({
        settings: EMAIL_REQUIRED,
        target: {
          env: "production",
          instanceId: "key_0123",
          instanceType: "prod",
          keySource: "--secret-key",
        },
        users: [user("b", { email: undefined, username: "b" })],
      }),
    );
    expect(checks.fixes[0]).toEqual({
      label: "Make Email optional at sign-up",
      url: "https://dashboard.clerk.com",
    });
  });

  // The rejects name the option; the fix gives the command for it.
  test.each([
    ["12345", "allow_numeric_usernames", "Allow numeric usernames"],
    [
      "ada.l",
      "allow_extended_special_characters",
      "Allow extended special characters in usernames",
    ],
  ])("offer the username option %p needs", async (username, rule, label) => {
    const checks = await checkImport(
      input({
        settings: settings({ email_address: { enabled: true }, username: { enabled: true } }),
        users: [user("a", { username }), user("b", { username: "ada" })],
      }),
    );
    expect(checks.fixes).toEqual([
      {
        label,
        command: `clerk config patch --app APP_ID --instance ins_1 --json '{"auth_username":{"${rule}":true}}'`,
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
    bare(
      Object.fromEntries(
        Object.entries(factors).map(([name, first_factors]) => [
          name,
          { enabled: true, used_for_first_factor: first_factors.length > 0, first_factors },
        ]),
      ),
      social,
    );

  // Clerk's shape: `password` lists no first factors of its own.
  test.each([
    ["password alone", { password: [] }, {}, true],
    ["password, and an email used only for sign-up", { password: [], email_address: [] }, {}, true],
    // Mirrors clerk_go: neither a passkey nor a reset is a way in on its own.
    ["password and passkey", { password: [], passkey: ["passkey"] }, {}, true],
    [
      "password and a reset code",
      { password: [], email_address: ["reset_password_email_code"] },
      {},
      true,
    ],
    ["password and email codes", { password: [], email_address: ["email_code"] }, {}, false],
    [
      "password and Google",
      { password: [] },
      { oauth_google: { enabled: true, authenticatable: true } },
      false,
    ],
    ["email links without passwords", { email_address: ["email_link"] }, {}, false],
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
    // Stored by Clerk, but Go's bcrypt refuses it at sign-in.
    ["$2a$03$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy", "bcrypt"],
    ["hash$salt$signer$sep$eight$14", "scrypt_firebase"],
    ["hash$salt", "scrypt_firebase"],
    ["argon2id$...", "argon2id"],
    ["scrypt:16384:16:1$salt$not-hex!", "scrypt_werkzeug"],
  ])("rejects %s as %s", (password, hasher) => {
    expect(hashShapeProblem(password, hasher)).toBeDefined();
  });
});
