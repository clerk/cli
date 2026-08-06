import { describe, expect, test } from "bun:test";
import type { UserSettingsJSON } from "../../../lib/fapi.ts";
import type { FieldAnalysis } from "./analysis.ts";
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
    expect(email?.detail).toContain("3 users lack it");
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

  test("uses the singular form for a single missing user", () => {
    const report = buildReadinessReport({
      analysis: analysis({
        totalUsers: 2,
        identifiers: { verifiedEmails: 1, hasAnyIdentifier: 2, username: 2 } as never,
      }),
      settings: settings({
        attributes: {
          email_address: { enabled: true, required: true },
          username: { enabled: true },
        },
      }),
    });
    expect(item(report, "Email")?.detail).toContain("1 user lacks it");
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
    expect(output).toContain("10 users ready to import");
    expect(output).toContain("2 failed validation");
    expect(output).toContain("2 without any identifier");
  });

  test("names the blocking rows and points at the dashboard", () => {
    const output = formatReadinessReport(blocked()).join("\n");
    expect(output).toContain("1 setting needs attention");
    expect(output).toContain("3 users lack it");
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
