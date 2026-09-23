import { test, expect, describe } from "bun:test";
import { hasConfigChanges } from "../config/push.ts";
import { isKnownDashboardPath } from "../open/dashboard-paths.ts";
import { CHECKS, CHECK_IDS, findCheck } from "./catalog.ts";
import { evaluate } from "./evaluate.ts";
import { INSECURE_CONFIG, INSECURE_OAUTH_CONFIG, SECURE_CONFIG } from "./fixtures.ts";
import { deepMerge } from "./merge.ts";
import type { CheckDef, CheckInput, InstanceConfig, InstanceRef } from "./types.ts";

const REF: InstanceRef = {
  appId: "app_1",
  instanceId: "ins_prod",
  environmentType: "production",
  label: "My App (production)",
};

const production = (config: InstanceConfig): CheckInput => ({
  config,
  environmentType: "production",
});

function withSection(config: InstanceConfig, key: string, patch: Record<string, unknown>) {
  return deepMerge(config, { [key]: patch });
}

const FIXABLE = CHECKS.filter((check) => check.patch);

// The OAuth check needs an enabled social connection, which would satisfy
// the passwordless check, so the two get different insecure documents.
const insecureFor = (check: CheckDef) =>
  check.id === "oauth-custom-credentials" ? INSECURE_OAUTH_CONFIG : INSECURE_CONFIG;

describe("security catalog", () => {
  test("ids are unique kebab-case", () => {
    expect(new Set(CHECK_IDS).size).toBe(CHECKS.length);
    for (const id of CHECK_IDS) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test.each(CHECKS)("$id links to a known dashboard path", (check) => {
    expect(isKnownDashboardPath(check.dashboardPath)).toBe(true);
  });

  test.each(CHECKS)("$id is met on the secure fixture", (check) => {
    expect(check.appliesTo?.(production(SECURE_CONFIG)) ?? true).toBe(true);
    expect(check.evaluate(production(SECURE_CONFIG)).met).toBe(true);
  });

  test.each(CHECKS)("$id is unmet on the insecure fixture", (check) => {
    expect(check.appliesTo?.(production(insecureFor(check))) ?? true).toBe(true);
    expect(check.evaluate(production(insecureFor(check))).met).toBe(false);
  });

  test.each(FIXABLE)("$id patch changes the insecure fixture and satisfies the check", (check) => {
    const patch = check.patch!(production(INSECURE_CONFIG));
    expect(hasConfigChanges(INSECURE_CONFIG, patch, true)).toBe(true);
    const projected = deepMerge(INSECURE_CONFIG, patch);
    expect(check.evaluate(production(projected)).met).toBe(true);
  });

  test.each(FIXABLE)("$id patch is a no-op on the secure fixture", (check) => {
    const patch = check.patch!(production(SECURE_CONFIG));
    expect(check.evaluate(production(deepMerge(SECURE_CONFIG, patch))).met).toBe(true);
  });
});

describe("not applicable checks", () => {
  const ids = (config: InstanceConfig, environmentType = "production") =>
    evaluate({ config, environmentType }, REF).map((f) => f.id);

  test("email checks drop out when email is not a sign-up identifier", () => {
    const config = withSection(INSECURE_CONFIG, "auth_email", { used_for_sign_up: false });
    const result = ids(config);
    for (const id of [
      "email-verification",
      "email-link-same-client",
      "block-disposable-email",
      "block-email-subaddresses",
    ]) {
      expect(result).not.toContain(id);
    }
  });

  test("password checks drop out when passwords are disabled", () => {
    const result = ids(withSection(INSECURE_CONFIG, "auth_password", { enabled: false }));
    for (const id of [
      "breach-detection",
      "breach-detection-sign-in",
      "device-trust",
      "password-min-length",
    ]) {
      expect(result).not.toContain(id);
    }
  });

  test.each([
    ["phone-verification", "auth_phone", { used_for_sign_up: false }],
    [
      "allowlist-on-sign-in",
      "auth_access_control",
      { allowlist_enabled: false, blocklist_enabled: false },
    ],
  ] as const)("%s drops out when its feature is off", (id, key, patch) => {
    expect(ids(withSection(INSECURE_CONFIG, key, { ...patch }))).not.toContain(id);
  });

  test("oauth-custom-credentials only applies to production with a social connection", () => {
    expect(ids(INSECURE_OAUTH_CONFIG, "development")).not.toContain("oauth-custom-credentials");
    expect(ids(INSECURE_CONFIG, "production")).not.toContain("oauth-custom-credentials");
    expect(ids(INSECURE_OAUTH_CONFIG, "production")).toContain("oauth-custom-credentials");
  });

  test("oauth-custom-credentials names the providers on shared credentials", () => {
    const finding = evaluate(production(INSECURE_OAUTH_CONFIG), REF).find(
      (f) => f.id === "oauth-custom-credentials",
    );
    expect(finding?.current).toContain("google");
  });
});

describe("blocked checks", () => {
  test("mfa-required is blocked until a second factor is available", () => {
    const finding = evaluate(production(INSECURE_CONFIG), REF).find((f) => f.id === "mfa-required");
    expect(finding?.status).toBe("blocked");
    expect(finding?.blockedBy).toBe("mfa");
    expect(finding?.patch).toBeNull();
    expect(finding?.remedy).toContain("Two-factor authentication");
  });

  test("mfa-required is unmet once a factor is available", () => {
    const config = withSection(INSECURE_CONFIG, "auth_multi_factor", {
      authenticator_app: { enabled: true },
    });
    const finding = evaluate(production(config), REF).find((f) => f.id === "mfa-required");
    expect(finding?.status).toBe("unmet");
    expect(finding?.patch).toEqual({ auth_multi_factor: { required_for_sign_up: true } });
  });
});

describe("patch details", () => {
  test("email-verification keeps existing verification strategies", () => {
    const config = withSection(INSECURE_CONFIG, "auth_email", {
      verification_strategies: ["email_link"],
    });
    expect(findCheck("email-verification")!.patch!(production(config))).toEqual({
      auth_email: { verify_at_sign_up: true, verification_strategies: ["email_link"] },
    });
  });

  test("email-verification falls back to email_code", () => {
    expect(findCheck("email-verification")!.patch!(production(INSECURE_CONFIG))).toEqual({
      auth_email: { verify_at_sign_up: true, verification_strategies: ["email_code"] },
    });
  });

  test("session-lifetime keeps a valid current duration", () => {
    const config = withSection(INSECURE_CONFIG, "session_settings", {
      maximum_lifetime: { enabled: false, duration_seconds: 86400 },
    });
    expect(findCheck("session-lifetime")!.patch!(production(config))).toEqual({
      session_settings: { maximum_lifetime: { enabled: true, duration_seconds: 86400 } },
    });
  });

  test("lockout-threshold treats a missing max_attempts as unmet, not zero", () => {
    const config = withSection(INSECURE_CONFIG, "auth_attack_protection", {
      user_lockout: { enabled: true, max_attempts: undefined },
    });
    const result = findCheck("lockout-threshold")!.evaluate(production(config));
    expect(result.met).toBe(false);
    expect(result.current).toBe("Threshold unknown");
  });

  test("lockout-threshold reports the disabled state", () => {
    const result = findCheck("lockout-threshold")!.evaluate(production(INSECURE_CONFIG));
    expect(result.current).toBe("Lockout disabled");
  });
});

describe("passwordless detection", () => {
  test.each([
    ["email code", "auth_email", { sign_in_strategies: ["email_code"] }],
    ["phone code", "auth_phone", { sign_in_strategies: ["phone_code"] }],
    ["passkey", "auth_passkey", { used_for_sign_in: true }],
    ["web3", "auth_web3", { used_for_sign_in: true }],
    ["social connection", "connection_oauth_github", { enabled: true }],
  ] as const)("%s counts as passwordless", (_name, key, patch) => {
    const config = withSection(INSECURE_CONFIG, key, { ...patch });
    expect(findCheck("passwordless-auth")!.evaluate(production(config)).met).toBe(true);
  });
});

describe("decision remedies", () => {
  test("remedy is a fix command carrying the suggested decision", () => {
    const mfa = evaluate(production(INSECURE_CONFIG), REF).find((f) => f.id === "mfa")!;
    expect(mfa.remedy).toContain(
      "clerk security fix mfa --factors authenticator,backup-code --app app_1 --instance ins_prod",
    );
    expect(mfa.decision).toEqual({
      flag: "factors",
      multiple: true,
      options: ["authenticator", "backup-code", "sms"],
      suggested: ["authenticator", "backup-code"],
    });
  });

  test("a blocked remedy names the combined fix command", () => {
    const required = evaluate(production(INSECURE_CONFIG), REF).find(
      (f) => f.id === "mfa-required",
    )!;
    expect(required.remedy).toContain("clerk security fix mfa mfa-required --app app_1");
  });
});

describe("plan-gated features", () => {
  test.each([
    ["mfa", ["app:mfa_totp", "app:mfa_phone_code", "app:mfa_backup_code"]],
    ["passkeys", ["app:passkey"]],
    ["session-lifetime", ["app:custom_session_duration"]],
  ])("%s reports features %j", (id, features) => {
    expect(findCheck(id)!.features).toEqual(features);
    const finding = evaluate(production(INSECURE_CONFIG), REF).find((f) => f.id === id);
    expect(finding?.features).toEqual(features);
  });

  test("checks without features omit the key", () => {
    const finding = evaluate(production(INSECURE_CONFIG), REF).find(
      (f) => f.id === "user-lockout",
    )!;
    expect("features" in finding).toBe(false);
  });
});

describe("decision patches", () => {
  const input = production(INSECURE_CONFIG);
  const mfa = findCheck("mfa")!.decision!;
  const passwordless = findCheck("passwordless-auth")!.decision!;

  test("mfa with sms enables the phone second factor", () => {
    expect(mfa.patch(["authenticator", "sms"], input)).toEqual({
      auth_multi_factor: { authenticator_app: { enabled: true } },
      auth_phone: { used_for_second_factor: true, second_factor_strategies: ["phone_code"] },
    });
  });

  test.each([
    ["email-code", { auth_email: { used_for_sign_in: true, sign_in_strategies: ["email_code"] } }],
    ["email-link", { auth_email: { used_for_sign_in: true, sign_in_strategies: ["email_link"] } }],
    ["phone-code", { auth_phone: { used_for_sign_in: true, sign_in_strategies: ["phone_code"] } }],
    ["passkey", { auth_passkey: { used_for_sign_in: true } }],
  ])("passwordless-auth %s", (strategy, expected) => {
    expect(passwordless.patch([strategy], input)).toEqual(expected);
  });

  test.each<{ values: string[] }>([
    { values: ["authenticator", "backup-code"] },
    { values: ["sms"] },
  ])("mfa is met after applying $values", ({ values }) => {
    const projected = deepMerge(INSECURE_CONFIG, mfa.patch(values, input));
    expect(findCheck("mfa")!.evaluate(production(projected)).met).toBe(true);
  });

  test.each(passwordless.options.map((o) => o.value))(
    "passwordless-auth is met after %s",
    (strategy) => {
      const projected = deepMerge(INSECURE_CONFIG, passwordless.patch([strategy], input));
      expect(findCheck("passwordless-auth")!.evaluate(production(projected)).met).toBe(true);
    },
  );
});

describe("effective protection", () => {
  const MATRIX = [
    { a: false, b: false },
    { a: false, b: true },
    { a: true, b: false },
    { a: true, b: true },
  ];

  test.each(MATRIX)(
    "mfa-required follows required_for_sign_up=$b, not required_for_sign_in=$a",
    ({ a: signIn, b: signUp }) => {
      const config = deepMerge(SECURE_CONFIG, {
        auth_multi_factor: { required_for_sign_in: signIn, required_for_sign_up: signUp },
      });
      expect(findCheck("mfa-required")!.evaluate(production(config)).met).toBe(signUp);
    },
  );

  test.each(MATRIX)(
    "breach-detection-sign-in needs enforce_hibp_on_sign_in=$b and disable_hibp=$a off",
    ({ a: disabled, b: enforce }) => {
      const config = deepMerge(SECURE_CONFIG, {
        auth_password: { disable_hibp: disabled, enforce_hibp_on_sign_in: enforce },
      });
      expect(findCheck("breach-detection-sign-in")!.evaluate(production(config)).met).toBe(
        !disabled && enforce,
      );
    },
  );

  test("backup codes alone do not satisfy MFA availability", () => {
    const config = deepMerge(INSECURE_CONFIG, {
      auth_multi_factor: { backup_code: { enabled: true } },
    });
    expect(findCheck("mfa")!.evaluate(production(config)).met).toBe(false);
  });
});

describe("custom flow notes", () => {
  test.each([
    "bot-protection",
    "device-trust",
    "mfa",
    "mfa-required",
    "email-verification",
    "phone-verification",
    "breach-detection-sign-in",
  ])("%s tells custom flows what to handle", (id) => {
    const note = findCheck(id)!.customFlows!;
    expect(note.note.length).toBeGreaterThan(0);
    expect(note.docsUrl).toStartWith("https://clerk.com/docs/guides/development/custom-flows/");
  });

  test("the note rides along on unmet findings only", () => {
    const unmet = evaluate(production(INSECURE_CONFIG), REF).find((f) => f.id === "mfa")!;
    expect(unmet.customFlows?.docsUrl).toContain("multi-factor-authentication");
    const met = evaluate(production(SECURE_CONFIG), REF).find((f) => f.id === "mfa")!;
    expect("customFlows" in met).toBe(false);
  });

  test("checks that only surface errors carry no note", () => {
    expect(findCheck("user-lockout")!.customFlows).toBeUndefined();
    expect(findCheck("password-min-length")!.customFlows).toBeUndefined();
  });
});
