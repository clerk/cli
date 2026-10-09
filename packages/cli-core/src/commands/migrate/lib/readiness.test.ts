import { describe, expect, test } from "bun:test";
import type { UserSettingsJSON } from "../../../lib/fapi.ts";
import { analyzeFields, type FieldAnalysis } from "./analysis.ts";
import { buildReadinessReport, type ReadinessItem } from "./readiness.ts";

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
  const identifiers = {
    verifiedEmails: 0,
    unverifiedEmails: 0,
    verifiedPhones: 0,
    unverifiedPhones: 0,
    username: 0,
    hasAnyIdentifier: overrides.totalUsers,
    ...overrides.identifiers,
  };
  return {
    identifiers: {
      // Hand-built rows have no user overlap, so "any" is the sum.
      anyEmail: identifiers.verifiedEmails + identifiers.unverifiedEmails,
      anyPhone: identifiers.verifiedPhones + identifiers.unverifiedPhones,
      ...identifiers,
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

  // A user with both a verified and an unverified phone is one user, not two.
  test("counts a user with both kinds of phone once", () => {
    const users = [
      { userId: "a", phone: "+15555550100", unverifiedPhoneNumbers: ["+15555550101"] },
      { userId: "b", phone: "+15555550102", unverifiedPhoneNumbers: ["+15555550103"] },
      { userId: "c", email: "c@x.dev" },
    ];
    const report = buildReadinessReport({
      analysis: analyzeFields(users),
      settings: settings({ attributes: { phone_number: { enabled: true } } }),
    });
    expect(item(report, "Phone")?.userCount).toBe(2);
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
