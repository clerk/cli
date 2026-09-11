import { describe, expect, test } from "bun:test";
import type { UserSettingsJSON } from "../../../lib/fapi.ts";
import type { FieldAnalysis } from "./analysis.ts";
import { buildReadinessReport } from "./readiness.ts";
import { applyChanges, buildChangePayload, buildSettingChanges } from "./modify-settings.ts";

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

/**
 * Changes are built from a real report rather than hand-written rows, so a row
 * whose `key` stops matching the path table fails here instead of silently
 * dropping out of the offer.
 */
function changesFor(input: Parameters<typeof buildReadinessReport>[0]) {
  return buildSettingChanges(buildReadinessReport(input).blocking);
}

describe("what gets offered", () => {
  test("a required field not every user has is offered as a relaxation", () => {
    const changes = changesFor({
      analysis: analysis({
        totalUsers: 5,
        identifiers: { verifiedEmails: 3, hasAnyIdentifier: 5 } as never,
      }),
      settings: settings({ attributes: { email_address: { enabled: true, required: true } } }),
    });

    expect(changes).toEqual([
      {
        id: "email_address",
        label: "Make Email optional at sign-up",
        section: "identifiers",
        kind: "relax",
        writes: [{ path: ["auth_email", "required_for_sign_up"], value: false }],
      },
    ]);
  });

  test("a field the file carries but Clerk has switched off is offered as an enable", () => {
    const changes = changesFor({
      analysis: analysis({
        totalUsers: 2,
        identifiers: { username: 2, hasAnyIdentifier: 2 } as never,
      }),
      settings: settings({ attributes: { username: { enabled: false } } }),
    });

    expect(changes).toEqual([
      {
        id: "username",
        label: "Enable Username",
        section: "identifiers",
        kind: "enable",
        writes: [{ path: ["auth_username", "used_for_sign_up"], value: true }],
      },
    ]);
  });

  /**
   * Clerk refuses a verifiable attribute that is on with no way to verify it —
   * `422 phone_number: verifiable attributes need to have at least one
   * verification` — and switching the attribute off empties the strategies, so
   * every enable that turned one off has to put one back.
   */
  test.each([
    ["phone_number", "auth_phone", "phone_code"],
    ["email_address", "auth_email", "email_code"],
  ])("enabling %s also restores its verification strategy", (attribute, group, strategy) => {
    const carriesIt = attribute === "phone_number" ? { verifiedPhones: 2 } : { verifiedEmails: 2 };

    const changes = changesFor({
      analysis: analysis({
        totalUsers: 2,
        identifiers: { ...carriesIt, hasAnyIdentifier: 2 } as never,
      }),
      settings: settings({ attributes: { [attribute]: { enabled: false } } }),
    });

    expect(changes[0]?.writes).toEqual([
      { path: [group, "used_for_sign_up"], value: true },
      { path: [group, "verification_strategies"], value: [strategy] },
    ]);
    expect(buildChangePayload(changes)).toEqual({
      [group]: { used_for_sign_up: true, verification_strategies: [strategy] },
    });
  });

  // Not verifiable, so no strategy to restore — one write is the whole change.
  test("enabling username takes a single write", () => {
    const changes = changesFor({
      analysis: analysis({ totalUsers: 2, identifiers: { username: 2 } as never }),
      settings: settings({ attributes: { username: { enabled: false } } }),
    });
    expect(changes[0]?.writes).toHaveLength(1);
  });

  test("a disabled social provider is offered under Clerk's own strategy name", () => {
    const changes = changesFor({
      analysis: analysis({
        totalUsers: 2,
        identifiers: { verifiedEmails: 2, hasAnyIdentifier: 2 } as never,
      }),
      settings: settings({
        attributes: { email_address: { enabled: true } },
        social: { oauth_x: { enabled: false } },
      }),
      // Supabase calls it `twitter`; the config document calls it `oauth_x`.
      providerCounts: { twitter: 2 },
    });

    expect(changes).toEqual([
      {
        id: "twitter",
        label: "Enable Twitter (X) sign-in",
        section: "social",
        kind: "enable",
        writes: [{ path: ["connection_oauth_x", "enabled"], value: true }],
      },
    ]);
  });

  // "Could not read" is not "switched off", so nothing is flagged and nothing
  // is offered — the report already degrades to a coverage-only listing.
  test("nothing is offered when the instance settings could not be read", () => {
    const changes = changesFor({
      analysis: analysis({
        totalUsers: 2,
        identifiers: { verifiedEmails: 1, hasAnyIdentifier: 2 } as never,
      }),
      settings: null,
    });

    expect(changes).toEqual([]);
  });

  test("nothing is offered when every field is already configured", () => {
    const changes = changesFor({
      analysis: analysis({
        totalUsers: 2,
        identifiers: { verifiedEmails: 2, hasAnyIdentifier: 2 } as never,
      }),
      settings: settings({ attributes: { email_address: { enabled: true, required: true } } }),
    });

    expect(changes).toEqual([]);
  });
});

describe("the payload", () => {
  test("collapses changes that share a parent into one branch", () => {
    const changes = changesFor({
      analysis: analysis({
        totalUsers: 3,
        identifiers: { verifiedEmails: 3, hasAnyIdentifier: 3 } as never,
        fieldCounts: { firstName: 2, lastName: 1 },
      }),
      settings: settings({
        attributes: {
          email_address: { enabled: true },
          first_name: { enabled: true, required: true },
          last_name: { enabled: true, required: true },
        },
      }),
    });

    expect(buildChangePayload(changes)).toEqual({
      user_model: { first_name: { required: false }, last_name: { required: false } },
    });
  });

  test("carries only the changes it is given", () => {
    const changes = changesFor({
      analysis: analysis({
        totalUsers: 3,
        identifiers: { verifiedEmails: 2, hasAnyIdentifier: 3 } as never,
        fieldCounts: { password: 1 },
      }),
      settings: settings({
        attributes: {
          email_address: { enabled: true, required: true },
          password: { enabled: true, required: true },
        },
      }),
    });
    expect(changes.map((change) => change.id)).toEqual(["email_address", "password"]);

    expect(buildChangePayload(changes.filter((change) => change.id === "password"))).toEqual({
      auth_password: { required: false },
    });
  });

  test("is empty when nothing was selected", () => {
    expect(buildChangePayload([])).toEqual({});
  });
});

/**
 * The redraw after a write comes from `applyChanges`, not a second fetch:
 * Clerk's Frontend API is eventually consistent, so re-reading straight after
 * the patch returns the pre-write settings and redraws every row just cleared.
 */
describe("the settings after a write", () => {
  /** The two fields a change touches, as `settings()` above builds them. */
  const attr = (value: { enabled: boolean; required: boolean }) =>
    value as unknown as UserSettingsJSON["attributes"]["email_address"];

  test("drops the requirement a relaxation removed", () => {
    const before = settings({ attributes: { email_address: { enabled: true, required: true } } });
    const input = {
      analysis: analysis({
        totalUsers: 5,
        identifiers: { verifiedEmails: 3, hasAnyIdentifier: 5 } as never,
      }),
      settings: before,
    };

    const after = applyChanges(before, changesFor(input));

    expect(after?.attributes.email_address).toEqual(attr({ enabled: true, required: false }));
    // The report is rebuilt from this, so the row must stop being flagged.
    expect(buildReadinessReport({ ...input, settings: after }).blocking).toEqual([]);
  });

  test("turns on what an enable switched on", () => {
    const before = settings({ attributes: { username: { enabled: false } } });
    const changes = changesFor({
      analysis: analysis({ totalUsers: 2, identifiers: { username: 2 } as never }),
      settings: before,
    });

    expect(applyChanges(before, changes)?.attributes.username).toEqual(
      attr({ enabled: true, required: false }),
    );
  });

  test("enables a provider under Clerk's strategy name, not the source platform's", () => {
    const before = settings({
      attributes: { email_address: { enabled: true } },
      social: { oauth_x: { enabled: false } },
    });
    const changes = changesFor({
      analysis: analysis({
        totalUsers: 2,
        identifiers: { verifiedEmails: 2, hasAnyIdentifier: 2 } as never,
      }),
      settings: before,
      providerCounts: { twitter: 2 },
    });

    expect(applyChanges(before, changes)?.social).toEqual({
      oauth_x: { enabled: true },
    } as unknown as UserSettingsJSON["social"]);
  });

  test("leaves the settings it was given untouched", () => {
    const before = settings({ attributes: { email_address: { enabled: true, required: true } } });
    const changes = changesFor({
      analysis: analysis({
        totalUsers: 5,
        identifiers: { verifiedEmails: 3, hasAnyIdentifier: 5 } as never,
      }),
      settings: before,
    });

    applyChanges(before, changes);

    expect(before.attributes.email_address).toMatchObject({ required: true });
  });

  test("passes null through — unreadable settings flag nothing to change", () => {
    expect(applyChanges(null, [])).toBeNull();
  });
});
