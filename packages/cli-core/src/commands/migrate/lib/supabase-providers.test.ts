import { describe, expect, test } from "bun:test";
import { toClerkStrategy } from "./clerk-config.ts";
import {
  countProviders,
  findDisabledProviders,
  findUsersWithOnlyDisabledProviders,
  getUserProviders,
} from "./supabase-providers.ts";

/** A Supabase row carrying the given providers, in the JSON export's shape. */
const user = (id: string, providers: string[] | string | undefined) => ({
  id,
  raw_app_meta_data:
    providers === undefined ? undefined : JSON.stringify({ provider: "email", providers }),
});

describe("getUserProviders", () => {
  test("reads providers from a JSON-string column, as a CSV export writes it", () => {
    expect(getUserProviders(user("u1", ["email", "discord"]))).toEqual(["email", "discord"]);
  });

  test("reads providers from an object column, as a JSON export writes it", () => {
    expect(getUserProviders({ id: "u1", raw_app_meta_data: { providers: ["google"] } })).toEqual([
      "google",
    ]);
  });

  test("splits a delimited providers string", () => {
    expect(
      getUserProviders({ id: "u1", raw_app_meta_data: { providers: "email, discord" } }),
    ).toEqual(["email", "discord"]);
  });

  test.each([
    ["missing column", { id: "u1" }],
    ["unparseable column", { id: "u1", raw_app_meta_data: "{not json" }],
    ["array column", { id: "u1", raw_app_meta_data: "[]" }],
    ["no providers key", { id: "u1", raw_app_meta_data: '{"provider":"email"}' }],
  ])("returns nothing for a %s", (_label, row) => {
    expect(getUserProviders(row)).toEqual([]);
  });
});

describe("toClerkStrategy", () => {
  test.each([
    ["google", "oauth_google"],
    ["discord", "oauth_discord"],
    ["github", "oauth_github"],
    ["azure", "oauth_microsoft"],
    ["twitter", "oauth_x"],
    ["slack_oidc", "oauth_slack"],
  ])("%s -> %s", (provider, strategy) => {
    expect(toClerkStrategy(provider)).toBe(strategy);
  });
});

describe("countProviders", () => {
  test("counts each provider across the export", () => {
    expect(
      countProviders([
        user("u1", ["email"]),
        user("u2", ["email", "discord"]),
        user("u3", ["discord"]),
      ]),
    ).toEqual({ email: 2, discord: 2 });
  });
});

describe("findDisabledProviders", () => {
  test("names the social providers Clerk does not have enabled", () => {
    const rows = [user("u1", ["email", "google"]), user("u2", ["discord"])];
    expect(findDisabledProviders(rows, ["oauth_google"], toClerkStrategy)).toEqual(["discord"]);
  });

  test("never treats email or phone as disabled", () => {
    const rows = [user("u1", ["email"]), user("u2", ["phone"]), user("u3", ["anonymous_users"])];
    expect(findDisabledProviders(rows, [], toClerkStrategy)).toEqual([]);
  });

  test("returns nothing when every provider is enabled", () => {
    const rows = [user("u1", ["google"]), user("u2", ["github"])];
    expect(findDisabledProviders(rows, ["oauth_google", "oauth_github"], toClerkStrategy)).toEqual(
      [],
    );
  });
});

describe("findUsersWithOnlyDisabledProviders", () => {
  test("excludes a user whose sole provider is disabled", () => {
    const result = findUsersWithOnlyDisabledProviders([user("u1", ["discord"])], ["discord"]);
    expect([...result.excludedIds]).toEqual(["u1"]);
    expect(result.byProvider).toEqual({ discord: 1 });
  });

  test("keeps a user who can still sign in with email", () => {
    const result = findUsersWithOnlyDisabledProviders(
      [user("u1", ["email", "discord"])],
      ["discord"],
    );
    expect(result.excludedIds.size).toBe(0);
  });

  test("keeps a user who has another enabled social provider", () => {
    const result = findUsersWithOnlyDisabledProviders(
      [user("u1", ["google", "discord"])],
      ["discord"],
    );
    expect(result.excludedIds.size).toBe(0);
  });

  test("excludes a user whose every provider is disabled", () => {
    const result = findUsersWithOnlyDisabledProviders(
      [user("u1", ["discord", "twitch"])],
      ["discord", "twitch"],
    );
    expect([...result.excludedIds]).toEqual(["u1"]);
    expect(result.byProvider).toEqual({ discord: 1, twitch: 1 });
  });

  test("keeps a user with no provider data at all", () => {
    const result = findUsersWithOnlyDisabledProviders([user("u1", undefined)], ["discord"]);
    expect(result.excludedIds.size).toBe(0);
  });

  test("excludes nobody when no provider is disabled", () => {
    const result = findUsersWithOnlyDisabledProviders([user("u1", ["discord"])], []);
    expect(result.excludedIds.size).toBe(0);
  });

  test("reports a per-provider breakdown across many users", () => {
    const result = findUsersWithOnlyDisabledProviders(
      [
        user("u1", ["discord"]),
        user("u2", ["discord"]),
        user("u3", ["twitch"]),
        user("u4", ["email", "discord"]),
      ],
      ["discord", "twitch"],
    );
    expect([...result.excludedIds]).toEqual(["u1", "u2", "u3"]);
    expect(result.byProvider).toEqual({ discord: 2, twitch: 1 });
  });
});
