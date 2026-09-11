import { describe, expect, test } from "bun:test";
import type { UserSettingsJSON } from "../../../lib/fapi.ts";
import { analyzeFields, type FieldAnalysis } from "./analysis.ts";
import { buildReadinessReport, formatReadinessReport, type ReadinessItem } from "./readiness.ts";

/** Instance settings carrying only the attributes and providers a test names. */
function settings(config: {
  attributes?: Record<string, { enabled: boolean; required?: boolean }>;
  social?: Record<string, { enabled: boolean }>;
}): UserSettingsJSON {
  return {
    attributes: Object.fromEntries(
      Object.entries(config.attributes ?? {}).map(([name, value]) => [
        name,
        { enabled: value.enabled, required: value.required ?? false },
      ]),
    ),
    social: config.social ?? {},
  } as unknown as UserSettingsJSON;
}

/** Field analysis with everything absent unless the test says otherwise. */
function analysis(overrides: Partial<FieldAnalysis> & { totalUsers: number }): FieldAnalysis {
  return {
    identifiers: {
      verifiedEmails: 0,
      unverifiedEmails: 0,
      verifiedPhones: 0,
      unverifiedPhones: 0,
      username: 0,
      hasAnyIdentifier: overrides.totalUsers,
      ...overrides.identifiers,
    },
    fieldCounts: overrides.fieldCounts ?? {},
    totalUsers: overrides.totalUsers,
  };
}

const item = (report: { items: ReadinessItem[] }, label: string) =>
  report.items.find((entry) => entry.label === label);

describe("which rows appear", () => {
  test("reports only the fields the file actually carries", () => {
    const report = buildReadinessReport({
      analysis: analysis({ totalUsers: 3, identifiers: { verifiedEmails: 3 } as never }),
      settings: settings({ attributes: { email_address: { enabled: true } } }),
    });
    expect(report.items.map((entry) => entry.label)).toEqual(["Email"]);
  });

  test("counts verified and unverified identifiers together", () => {
    const report = buildReadinessReport({
      analysis: analysis({
        totalUsers: 5,
        identifiers: { verifiedEmails: 3, unverifiedEmails: 2, hasAnyIdentifier: 5 } as never,
      }),
      settings: settings({ attributes: { email_address: { enabled: true } } }),
    });
    expect(item(report, "Email")?.userCount).toBe(5);
  });

  test("groups rows into identifiers, auth and user model", () => {
    const report = buildReadinessReport({
      analysis: analysis({
        totalUsers: 2,
        identifiers: { verifiedEmails: 2, username: 2, hasAnyIdentifier: 2 } as never,
        fieldCounts: { password: 2, firstName: 2, lastName: 1 },
      }),
      settings: settings({}),
    });
    expect(report.items.map((entry) => [entry.label, entry.section])).toEqual([
      ["Email", "identifiers"],
      ["Username", "identifiers"],
      ["Password", "auth"],
      ["First name", "model"],
      ["Last name", "model"],
    ]);
  });
});

describe("required in Clerk but missing from the file", () => {
  // The expensive case: those users fail one at a time, mid-import, after
  // earlier users have already been created.
  test("flags an attribute Clerk requires that not every user has", () => {
    const report = buildReadinessReport({
      analysis: analysis({
        totalUsers: 10,
        identifiers: { verifiedEmails: 7, hasAnyIdentifier: 10, username: 10 } as never,
      }),
      settings: settings({
        attributes: {
          email_address: { enabled: true, required: true },
          username: { enabled: true },
        },
      }),
    });

    const email = item(report, "Email");
    expect(email?.blocking).toBe(true);
    expect(email?.detail).toContain("required in Clerk");
    // A required identifier is the one verdict Clerk refuses the user over.
    expect(email?.consequence).toBe("rejects");
    expect(report.blocking).toHaveLength(1);
  });

  test("does not flag a required attribute every user has", () => {
    const report = buildReadinessReport({
      analysis: analysis({
        totalUsers: 4,
        identifiers: { verifiedEmails: 4, hasAnyIdentifier: 4 } as never,
      }),
      settings: settings({ attributes: { email_address: { enabled: true, required: true } } }),
    });
    expect(report.blocking).toHaveLength(0);
  });

  test("does not flag an enabled-but-optional attribute that some users lack", () => {
    const report = buildReadinessReport({
      analysis: analysis({
        totalUsers: 10,
        identifiers: { verifiedEmails: 10, hasAnyIdentifier: 10 } as never,
        fieldCounts: { firstName: 2 },
      }),
      settings: settings({
        attributes: { email_address: { enabled: true }, first_name: { enabled: true } },
      }),
    });
    expect(report.blocking).toHaveLength(0);
  });

  // The import sends `skip_password_requirement`, so a required password costs
  // the user their password rather than their whole account.
  test("a required password drops rather than rejects", () => {
    const report = buildReadinessReport({
      analysis: analysis({
        totalUsers: 4,
        identifiers: { verifiedEmails: 4, hasAnyIdentifier: 4 } as never,
        fieldCounts: { password: 1 },
      }),
      settings: settings({
        attributes: {
          email_address: { enabled: true },
          password: { enabled: true, required: true },
        },
      }),
    });
    expect(item(report, "Password")?.consequence).toBe("drops");
  });
});

describe("present in the file but disabled in Clerk", () => {
  test("flags an attribute the instance has switched off", () => {
    const report = buildReadinessReport({
      analysis: analysis({
        totalUsers: 3,
        identifiers: { verifiedEmails: 3, username: 3, hasAnyIdentifier: 3 } as never,
      }),
      settings: settings({
        attributes: { email_address: { enabled: true }, username: { enabled: false } },
      }),
    });

    const username = item(report, "Username");
    expect(username?.blocking).toBe(true);
    expect(username?.detail).toBe("not enabled in Clerk");
  });

  test("flags a social provider users signed up with that Clerk lacks", () => {
    const report = buildReadinessReport({
      analysis: analysis({
        totalUsers: 4,
        identifiers: { verifiedEmails: 4, hasAnyIdentifier: 4 } as never,
      }),
      settings: settings({
        attributes: { email_address: { enabled: true } },
        social: { oauth_google: { enabled: true } },
      }),
      providerCounts: { google: 3, discord: 1 },
    });

    expect(item(report, "Google")?.blocking).toBe(false);
    expect(item(report, "Discord")?.blocking).toBe(true);
    expect(report.blocking.map((entry) => entry.label)).toEqual(["Discord"]);
  });

  test("maps a provider whose Clerk strategy name differs", () => {
    const report = buildReadinessReport({
      analysis: analysis({ totalUsers: 1, identifiers: { verifiedEmails: 1 } as never }),
      settings: settings({
        attributes: { email_address: { enabled: true } },
        social: { oauth_microsoft: { enabled: true } },
      }),
      providerCounts: { azure: 1 },
    });
    expect(item(report, "Microsoft (Azure)")?.blocking).toBe(false);
  });

  test("ignores a provider no user actually signed up with", () => {
    const report = buildReadinessReport({
      analysis: analysis({ totalUsers: 1, identifiers: { verifiedEmails: 1 } as never }),
      settings: settings({ attributes: { email_address: { enabled: true } } }),
      providerCounts: { discord: 0 },
    });
    expect(item(report, "Discord")).toBeUndefined();
  });
});

describe("when the instance settings cannot be read", () => {
  const unreadable = () =>
    buildReadinessReport({
      analysis: analysis({
        totalUsers: 3,
        identifiers: { verifiedEmails: 3, hasAnyIdentifier: 3 } as never,
      }),
      settings: null,
    });

  test("marks the report as degraded rather than failing", () => {
    expect(unreadable().settingsUnavailable).toBe(true);
  });

  // `null` means "not read", which must not be confused with `false`
  // ("read, and it is off") — the latter blocks, the former cannot.
  test("claims nothing about Clerk, so nothing blocks", () => {
    const report = unreadable();
    expect(item(report, "Email")?.clerkEnabled).toBeNull();
    expect(report.blocking).toHaveLength(0);
  });

  test("still reports what the file contains", () => {
    expect(unreadable().items.map((entry) => entry.label)).toEqual(["Email"]);
  });

  test("renders a note explaining the checks are coverage only", () => {
    const output = formatReadinessReport(unreadable()).join("\n");
    expect(output).toContain("Could not read this instance's settings");
    expect(output).toContain("dashboard.clerk.com");
  });
});

describe("file-level totals", () => {
  test("counts users with no identifier at all", () => {
    const report = buildReadinessReport({
      analysis: analysis({
        totalUsers: 10,
        identifiers: { verifiedEmails: 7, hasAnyIdentifier: 7 } as never,
      }),
      settings: settings({}),
    });
    expect(report.withoutIdentifier).toBe(3);
  });

  test("carries the validation failure count through", () => {
    const report = buildReadinessReport({
      analysis: analysis({ totalUsers: 2 }),
      settings: settings({}),
      validationFailed: 5,
    });
    expect(report.validationFailed).toBe(5);
  });
});

/**
 * The counts an operator actually decides on. Built from the users themselves,
 * because per-field coverage cannot answer them: the users missing an email and
 * the users missing a password overlap by an amount only a per-user pass knows.
 */
describe("what the settings mean for these users", () => {
  const REQUIRE_EMAIL_AND_PASSWORD = settings({
    attributes: {
      email_address: { enabled: true, required: true },
      password: { enabled: true, required: true },
    },
  });

  /** Two with everything, two with no email, one with an email but no password. */
  const USERS = [
    { userId: "a", email: "a@x.dev", password: "hash" },
    { userId: "b", email: "b@x.dev", password: "hash" },
    { userId: "c", username: "c" },
    { userId: "d", username: "d" },
    { userId: "e", email: "e@x.dev" },
  ] as never;

  const outcomes = () =>
    buildReadinessReport({
      analysis: analyzeFields(USERS),
      users: USERS,
      settings: REQUIRE_EMAIL_AND_PASSWORD,
    }).outcomes;

  test("the three totals account for every user exactly once", () => {
    const result = outcomes();
    expect(result).toMatchObject({ rejected: 2, incomplete: 1, complete: 2 });
    expect((result?.rejected ?? 0) + (result?.incomplete ?? 0) + (result?.complete ?? 0)).toBe(5);
  });

  // The file has three users without a password, but two of them are already
  // rejected for the email — counting them twice would overstate the damage.
  test("a rejected user is not also counted as incomplete", () => {
    expect(outcomes()?.incompleteReasons).toEqual([
      {
        label: "Password",
        count: 1,
        detail: expect.stringContaining("1 has no password, which this instance requires"),
      },
    ]);
  });

  test("names why the rejected users are rejected", () => {
    expect(outcomes()?.rejectedReasons).toEqual([
      { label: "Email", count: 2, detail: "2 have no email, which this instance requires" },
    ]);
  });

  /**
   * The rejected users lose nothing today — they are not being created. But the
   * moment the operator relaxes the requirement rejecting them (one of the
   * changes on offer) every masked setting lands at once. Surfacing it here is
   * what saves an apply → re-check → discover → apply → re-check loop.
   */
  describe("what is masked behind a rejection", () => {
    // b and c have no email, so both are rejected; b also carries a phone the
    // instance is not set up to store. Exactly the shape the supabase sample
    // hits: every phone belongs to a user who has no email.
    const MASKED_USERS = [
      { userId: "a", email: "a@x.dev" },
      { userId: "b", username: "b", phone: "+15551234567" },
      { userId: "c", username: "c" },
    ] as never;

    const report = (attributes: Record<string, { enabled: boolean; required?: boolean }>) =>
      buildReadinessReport({
        analysis: analyzeFields(MASKED_USERS),
        users: MASKED_USERS,
        settings: settings({ attributes }),
      });

    const REQUIRE_EMAIL_PHONE_OFF = {
      email_address: { enabled: true, required: true },
      phone_number: { enabled: false },
      username: { enabled: true },
    };

    test("counts a setting that only bites once the rejected users get in", () => {
      const outcomes = report(REQUIRE_EMAIL_PHONE_OFF).outcomes;

      expect(outcomes).toMatchObject({ rejected: 2, incomplete: 0, complete: 1 });
      expect(outcomes?.maskedReasons).toEqual([
        {
          label: "Phone",
          count: 1,
          detail: "1 has a phone, which this instance is not set up to store",
        },
      ]);
    });

    test("keeps it out of the incomplete count, which is about users being imported", () => {
      expect(report(REQUIRE_EMAIL_PHONE_OFF).outcomes?.incompleteReasons).toEqual([]);
    });

    test("renders it under the rejected group", () => {
      const output = formatReadinessReport(report(REQUIRE_EMAIL_PHONE_OFF)).join("\n");

      expect(output).toContain("If you import them, this applies to them too:");
      expect(output).toContain("1 has a phone, which this instance is not set up to store");
    });

    // Enabling phone is the other change on offer, and it empties the block —
    // which is the check that the two offers really do interact this way.
    test("is empty once the masked setting is no longer a problem", () => {
      const outcomes = report({
        email_address: { enabled: true, required: true },
        phone_number: { enabled: true },
        username: { enabled: true },
      }).outcomes;

      expect(outcomes).toMatchObject({ rejected: 2 });
      expect(outcomes?.maskedReasons).toEqual([]);
    });
  });

  test("a disabled attribute costs the users who carry it, not the ones who don't", () => {
    const users = [
      { userId: "a", email: "a@x.dev", username: "a" },
      { userId: "b", email: "b@x.dev" },
    ] as never;

    const result = buildReadinessReport({
      analysis: analyzeFields(users),
      users,
      settings: settings({
        attributes: { email_address: { enabled: true }, username: { enabled: false } },
      }),
    }).outcomes;

    expect(result).toMatchObject({ rejected: 0, incomplete: 1, complete: 1 });
    expect(result?.incompleteReasons[0]?.detail).toContain("not set up to store");
  });

  test("is omitted when the caller passes no users", () => {
    const report = buildReadinessReport({
      analysis: analyzeFields(USERS),
      settings: REQUIRE_EMAIL_AND_PASSWORD,
    });
    expect(report.outcomes).toBeUndefined();
  });

  test("renders each outcome with the reasons behind it", () => {
    const output = formatReadinessReport(
      buildReadinessReport({
        analysis: analyzeFields(USERS),
        users: USERS,
        settings: REQUIRE_EMAIL_AND_PASSWORD,
      }),
    ).join("\n");

    expect(output).toContain("2 users will not be imported");
    expect(output).toContain("1 user will be imported, but not everything they carry");
    expect(output).toContain("2 users will be imported in full");
    expect(output).toContain("they will have to reset it to sign in");
  });
});

describe("rendering", () => {
  const blocked = () =>
    buildReadinessReport({
      analysis: analysis({
        totalUsers: 10,
        identifiers: { verifiedEmails: 7, hasAnyIdentifier: 8, username: 10 } as never,
      }),
      settings: settings({
        attributes: {
          email_address: { enabled: true, required: true },
          username: { enabled: true },
        },
      }),
      validationFailed: 2,
    });

  test("leads with the counts an operator needs before confirming", () => {
    const output = formatReadinessReport(blocked()).join("\n");
    expect(output).toContain("10 users in this file");
    expect(output).toContain("2 failed validation");
    expect(output).toContain("2 without any identifier");
  });

  test("names the blocking rows and points at the dashboard", () => {
    const output = formatReadinessReport(blocked()).join("\n");
    expect(output).toContain("1 setting needs attention");
    expect(output).toContain("required in Clerk, and not every user has one");
    expect(output).toContain("dashboard.clerk.com");
  });

  test("confirms a clean report when nothing blocks", () => {
    const output = formatReadinessReport(
      buildReadinessReport({
        analysis: analysis({
          totalUsers: 2,
          identifiers: { verifiedEmails: 2, hasAnyIdentifier: 2 } as never,
        }),
        settings: settings({ attributes: { email_address: { enabled: true } } }),
      }),
    ).join("\n");
    expect(output).toContain("Every field in this file is configured in Clerk");
  });

  test("does not claim everything is configured when settings were unreadable", () => {
    const output = formatReadinessReport(
      buildReadinessReport({ analysis: analysis({ totalUsers: 1 }), settings: null }),
    ).join("\n");
    expect(output).not.toContain("Every field in this file is configured");
  });

  test("renders section headings only for sections that have rows", () => {
    const output = formatReadinessReport(
      buildReadinessReport({
        analysis: analysis({
          totalUsers: 1,
          identifiers: { verifiedEmails: 1, hasAnyIdentifier: 1 } as never,
        }),
        settings: settings({ attributes: { email_address: { enabled: true } } }),
      }),
    ).join("\n");
    expect(output).toContain("Identifiers");
    expect(output).not.toContain("Social connections");
    expect(output).not.toContain("User model");
  });
});
