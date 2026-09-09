// Pure checks over the Platform config document. `critical` is the account-takeover
// kill chain and caps the grade at C. Composition rules and zxcvbn scores are
// intentionally absent: Clerk no longer recommends them (NIST 800-63B).

import { isRecord } from "../../lib/objects.ts";
import type { CheckDecision, CheckDef, CheckInput, ConfigPatch, InstanceConfig } from "./types.ts";

const DOCS = "https://clerk.com/docs/guides";
const DOCS_SIGN_IN_OPTIONS = `${DOCS}/configure/auth-strategies/sign-up-sign-in-options`;
const DOCS_PASSWORDS = `${DOCS}/secure/password-protection-and-rules`;
const DOCS_LOCKOUT = `${DOCS}/secure/user-lockout`;
const DOCS_SESSIONS = `${DOCS}/secure/session-options`;
const DOCS_RESTRICTIONS = `${DOCS}/secure/restricting-access`;

// Backend minimum for session durations.
const MIN_SESSION_SECONDS = 300;
const DEFAULT_LIFETIME_SECONDS = 604800;
const MIN_PASSWORD_LENGTH = 8;

// Plan-gated in the Dashboard.
const FEATURE_MFA = "app:mfa_totp";
const FEATURE_PASSKEY = "app:passkey";
const FEATURE_LIFETIME = "app:custom_session_duration";

const rec = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

function at(config: InstanceConfig, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => rec(node)[key], config);
}

const flag = (config: InstanceConfig, path: string): boolean => at(config, path) === true;
const num = (config: InstanceConfig, path: string): number => {
  const value = at(config, path);
  return typeof value === "number" ? value : 0;
};
const list = (config: InstanceConfig, path: string): string[] => {
  const value = at(config, path);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
};

function booleanCheck(
  path: string,
  opts: { invert?: boolean; labels?: [string, string] } = {},
): Pick<CheckDef, "path" | "evaluate"> {
  const [metLabel, unmetLabel] = opts.labels ?? ["Enabled", "Disabled"];
  return {
    path,
    evaluate({ config }) {
      const raw = flag(config, path);
      const met = opts.invert ? !raw : raw;
      return {
        met,
        currentValue: raw,
        recommendedValue: !opts.invert,
        current: met ? metLabel : unmetLabel,
        recommended: metLabel,
      };
    },
  };
}

export const emailEnabled = (config: InstanceConfig): boolean =>
  flag(config, "auth_email.used_for_sign_up");
export const passwordEnabled = (config: InstanceConfig): boolean =>
  flag(config, "auth_password.enabled");
export const phoneEnabled = (config: InstanceConfig): boolean =>
  flag(config, "auth_phone.used_for_sign_up");

export const mfaAvailable = (config: InstanceConfig): boolean =>
  flag(config, "auth_multi_factor.authenticator_app.enabled") ||
  flag(config, "auth_phone.used_for_second_factor");

export function enabledOAuthProviders(config: InstanceConfig): string[] {
  return Object.keys(config)
    .filter((key) => key.startsWith("connection_oauth_") && flag(config, `${key}.enabled`))
    .map((key) => key.slice("connection_oauth_".length));
}

export function passwordlessEnabled(config: InstanceConfig): boolean {
  const emailCode = list(config, "auth_email.sign_in_strategies").some((s) =>
    ["email_code", "email_link"].includes(s),
  );
  const phoneCode = list(config, "auth_phone.sign_in_strategies").includes("phone_code");
  return (
    emailCode ||
    phoneCode ||
    flag(config, "auth_passkey.used_for_sign_in") ||
    flag(config, "auth_web3.used_for_sign_in") ||
    enabledOAuthProviders(config).length > 0
  );
}

const union = (values: string[], value: string) =>
  values.includes(value) ? values : [...values, value];

const MFA_DECISION: CheckDecision = {
  flag: "factors",
  prompt: "Which second factors should users be able to enroll?",
  multiple: true,
  options: [
    { value: "authenticator", label: "Authenticator app (TOTP)" },
    { value: "backup-code", label: "Backup codes" },
    { value: "sms", label: "SMS code" },
  ],
  defaults: () => ["authenticator", "backup-code"],
  validate(values, { config }) {
    if (
      values.includes("backup-code") &&
      !values.includes("authenticator") &&
      !values.includes("sms") &&
      !mfaAvailable(config)
    ) {
      return "Backup codes require another second factor. Include authenticator or sms in --factors.";
    }
  },
  patch(values, { config }) {
    const patch: ConfigPatch = {};
    const mfa: Record<string, unknown> = {};
    if (values.includes("authenticator")) mfa.authenticator_app = { enabled: true };
    if (values.includes("backup-code")) mfa.backup_code = { enabled: true };
    if (Object.keys(mfa).length) patch.auth_multi_factor = mfa;
    if (values.includes("sms")) {
      patch.auth_phone = {
        used_for_second_factor: true,
        second_factor_strategies: union(
          list(config, "auth_phone.second_factor_strategies"),
          "phone_code",
        ),
      };
    }
    return patch;
  },
};

const PASSWORDLESS_DECISION: CheckDecision = {
  flag: "strategy",
  prompt: "Which passwordless sign-in method should be offered?",
  multiple: false,
  options: [
    { value: "email-code", label: "One-time code by email" },
    { value: "email-link", label: "Magic link by email" },
    { value: "phone-code", label: "One-time code by SMS" },
    { value: "passkey", label: "Passkeys" },
  ],
  // Prefer an identifier already collected so sign-up keeps its shape.
  defaults: ({ config }) =>
    emailEnabled(config) || flag(config, "auth_email.used_for_sign_in")
      ? ["email-code"]
      : phoneEnabled(config) || flag(config, "auth_phone.used_for_sign_in")
        ? ["phone-code"]
        : ["passkey"],
  patch([strategy], { config }) {
    if (strategy === "passkey") return { auth_passkey: { used_for_sign_in: true } };
    const section = strategy === "phone-code" ? "auth_phone" : "auth_email";
    const apiStrategy = strategy!.replace("-", "_");
    return {
      [section]: {
        used_for_sign_in: true,
        sign_in_strategies: union(list(config, `${section}.sign_in_strategies`), apiStrategy),
      },
    };
  },
};

function verifyAtSignUpPatch(section: string, fallback: string) {
  return ({ config }: CheckInput) => {
    const strategies = list(config, `${section}.verification_strategies`);
    return {
      [section]: {
        verify_at_sign_up: true,
        verification_strategies: strategies.length ? strategies : [fallback],
      },
    };
  };
}

export const CHECKS: CheckDef[] = [
  // --- critical ---
  {
    id: "bot-protection",
    title: "Bot sign-up protection",
    description: "Require a CAPTCHA challenge to block automated sign-ups.",
    severity: "critical",
    dashboardPath: "user-authentication",
    docsUrl: `${DOCS}/secure/bot-protection`,
    ...booleanCheck("auth_attack_protection.bot_protection.captcha_enabled"),
    patch: () => ({
      auth_attack_protection: {
        bot_protection: { captcha_enabled: true, captcha_widget_type: "smart" },
      },
    }),
  },
  {
    id: "breach-detection",
    title: "Breached password detection",
    description: "Reject passwords found in known data breaches (HaveIBeenPwned).",
    severity: "critical",
    dashboardPath: "user-authentication",
    docsUrl: DOCS_PASSWORDS,
    appliesTo: ({ config }) => passwordEnabled(config),
    ...booleanCheck("auth_password.disable_hibp", { invert: true }),
    patch: () => ({ auth_password: { disable_hibp: false, enforce_hibp_on_sign_in: true } }),
  },
  {
    id: "user-lockout",
    title: "Brute-force lockout",
    description: "Lock accounts after repeated failed sign-in attempts.",
    severity: "critical",
    dashboardPath: "user-authentication",
    docsUrl: DOCS_LOCKOUT,
    ...booleanCheck("auth_attack_protection.user_lockout.enabled"),
    patch: () => ({ auth_attack_protection: { user_lockout: { enabled: true } } }),
  },
  {
    id: "device-trust",
    title: "Device trust",
    description:
      "Challenge sign-ins from unrecognized devices, a key defense against credential stuffing.",
    severity: "critical",
    dashboardPath: "user-authentication",
    docsUrl: `${DOCS}/secure/device-trust`,
    appliesTo: ({ config }) => passwordEnabled(config),
    ...booleanCheck("auth_password.device_trust.enabled"),
    patch: () => ({ auth_password: { device_trust: { enabled: true } } }),
  },
  {
    id: "mfa",
    title: "Two-factor authentication",
    description: "Offer a second factor (authenticator app, SMS, or backup codes) to your users.",
    severity: "critical",
    path: "auth_multi_factor",
    dashboardPath: "user-authentication",
    docsUrl: DOCS_SIGN_IN_OPTIONS,
    feature: FEATURE_MFA,
    evaluate({ config }) {
      const met = mfaAvailable(config);
      return {
        met,
        currentValue: met,
        recommendedValue: true,
        current: met ? "Available" : "Not available",
        recommended: "Available",
      };
    },
    decision: MFA_DECISION,
  },
  {
    id: "passwordless-auth",
    title: "Passwordless authentication available",
    description:
      "Offer at least one passwordless sign-in method (passkey, email or SMS code, or social) so users are not limited to passwords.",
    severity: "critical",
    path: "auth_email.sign_in_strategies",
    dashboardPath: "user-authentication",
    docsUrl: DOCS_SIGN_IN_OPTIONS,
    evaluate({ config }) {
      const met = passwordlessEnabled(config);
      return {
        met,
        currentValue: met,
        recommendedValue: true,
        current: met ? "Available" : "None",
        recommended: "At least one",
      };
    },
    decision: PASSWORDLESS_DECISION,
  },
  {
    id: "email-verification",
    title: "Verify email at sign-up",
    description: "Require users to verify their email address before completing sign-up.",
    severity: "critical",
    dashboardPath: "user-authentication",
    docsUrl: DOCS_SIGN_IN_OPTIONS,
    appliesTo: ({ config }) => emailEnabled(config),
    ...booleanCheck("auth_email.verify_at_sign_up", { labels: ["Required", "Not required"] }),
    patch: verifyAtSignUpPatch("auth_email", "email_code"),
  },

  // --- recommended ---
  {
    id: "breach-detection-sign-in",
    title: "Reject breached passwords on sign-in",
    description: "Force a password reset when an existing password is later found in a breach.",
    severity: "recommended",
    dashboardPath: "user-authentication",
    docsUrl: DOCS_PASSWORDS,
    appliesTo: ({ config }) => passwordEnabled(config),
    path: "auth_password.enforce_hibp_on_sign_in",
    evaluate({ config }) {
      const met =
        !flag(config, "auth_password.disable_hibp") &&
        flag(config, "auth_password.enforce_hibp_on_sign_in");
      return {
        met,
        currentValue: met,
        recommendedValue: true,
        current: met ? "Enabled" : "Disabled",
        recommended: "Enabled",
      };
    },
    patch: () => ({ auth_password: { disable_hibp: false, enforce_hibp_on_sign_in: true } }),
  },
  {
    id: "lockout-threshold",
    title: "Strict lockout threshold",
    description: "Lock accounts after 10 or fewer failed attempts.",
    severity: "recommended",
    path: "auth_attack_protection.user_lockout.max_attempts",
    dashboardPath: "user-authentication",
    docsUrl: DOCS_LOCKOUT,
    evaluate({ config }) {
      const enabled = flag(config, "auth_attack_protection.user_lockout.enabled");
      const raw = at(config, "auth_attack_protection.user_lockout.max_attempts");
      const attempts = typeof raw === "number" ? raw : undefined;
      return {
        met: enabled && attempts !== undefined && attempts <= 10,
        currentValue: enabled ? (attempts ?? null) : null,
        recommendedValue: 10,
        current: !enabled
          ? "Lockout disabled"
          : attempts === undefined
            ? "Threshold unknown"
            : `${attempts} attempts`,
        recommended: "10 or fewer",
      };
    },
    patch: () => ({
      auth_attack_protection: { user_lockout: { enabled: true, max_attempts: 10 } },
    }),
  },
  {
    id: "mfa-required",
    title: "Require two-factor authentication",
    description: "Force every user to set up a second factor, not just offer it.",
    severity: "recommended",
    path: "auth_multi_factor.required_for_sign_up",
    dashboardPath: "user-authentication",
    docsUrl: DOCS_SIGN_IN_OPTIONS,
    blockedBy: "mfa",
    evaluate({ config }) {
      // Drives the setup-mfa task; required_for_sign_in is a different setting.
      const met = flag(config, "auth_multi_factor.required_for_sign_up");
      return {
        met,
        currentValue: met,
        recommendedValue: true,
        current: met ? "Required" : "Optional",
        recommended: "Required",
      };
    },
    patch: () => ({ auth_multi_factor: { required_for_sign_up: true } }),
  },
  {
    id: "passkeys",
    title: "Passkeys",
    description: "Offer phishing-resistant passkeys as a sign-in option for your users.",
    severity: "recommended",
    dashboardPath: "user-authentication",
    docsUrl: DOCS_SIGN_IN_OPTIONS,
    feature: FEATURE_PASSKEY,
    ...booleanCheck("auth_passkey.used_for_sign_in"),
    patch: () => ({ auth_passkey: { used_for_sign_in: true } }),
  },
  {
    id: "phone-verification",
    title: "Verify phone at sign-up",
    description: "Require users to verify their phone number before completing sign-up.",
    severity: "recommended",
    dashboardPath: "user-authentication",
    docsUrl: DOCS_SIGN_IN_OPTIONS,
    appliesTo: ({ config }) => phoneEnabled(config),
    ...booleanCheck("auth_phone.verify_at_sign_up", { labels: ["Required", "Not required"] }),
    patch: verifyAtSignUpPatch("auth_phone", "phone_code"),
  },
  {
    id: "password-min-length",
    title: "Minimum password length",
    description: `Require passwords of at least ${MIN_PASSWORD_LENGTH} characters.`,
    severity: "recommended",
    path: "auth_password.min_length",
    dashboardPath: "user-authentication",
    docsUrl: DOCS_PASSWORDS,
    appliesTo: ({ config }) => passwordEnabled(config),
    evaluate({ config }) {
      const length = num(config, "auth_password.min_length");
      return {
        met: length >= MIN_PASSWORD_LENGTH,
        currentValue: length,
        recommendedValue: MIN_PASSWORD_LENGTH,
        current: `${length} characters`,
        recommended: `${MIN_PASSWORD_LENGTH} or more`,
      };
    },
    patch: () => ({ auth_password: { min_length: MIN_PASSWORD_LENGTH } }),
  },
  {
    id: "allowlist-on-sign-in",
    title: "Enforce allowlist and blocklist on sign-in",
    description:
      "Apply sign-up restrictions to sign-in too, so an identifier that is later blocked cannot keep signing in.",
    severity: "recommended",
    dashboardPath: "user-authentication",
    docsUrl: DOCS_RESTRICTIONS,
    appliesTo: ({ config }) =>
      flag(config, "auth_access_control.allowlist_enabled") ||
      flag(config, "auth_access_control.blocklist_enabled"),
    ...booleanCheck("auth_access_control.allowlist_blocklist_enforced_on_sign_in"),
    patch: () => ({ auth_access_control: { allowlist_blocklist_enforced_on_sign_in: true } }),
  },
  {
    id: "oauth-custom-credentials",
    title: "Custom OAuth credentials in production",
    description:
      "Use your own OAuth client credentials for social connections instead of Clerk's shared development credentials.",
    severity: "recommended",
    path: "connection_oauth_*.client_id",
    dashboardPath: "user-authentication",
    docsUrl: `${DOCS}/configure/auth-strategies/social-connections/overview`,
    appliesTo: ({ config, environmentType }) =>
      environmentType === "production" && enabledOAuthProviders(config).length > 0,
    evaluate({ config }) {
      const shared = enabledOAuthProviders(config).filter(
        (provider) => !at(config, `connection_oauth_${provider}.client_id`),
      );
      return {
        met: shared.length === 0,
        currentValue: shared,
        recommendedValue: [],
        current: shared.length ? `Shared credentials: ${shared.join(", ")}` : "Custom credentials",
        recommended: "Custom credentials for every provider",
      };
    },
    manualRemedy:
      "Register an OAuth app with each provider and set `client_id` and `client_secret` on its `connection_oauth_<provider>` config key.",
  },

  // --- good to have ---
  {
    id: "session-lifetime",
    title: "Bounded session lifetime",
    description: "Expire sessions after a maximum lifetime instead of keeping them indefinitely.",
    severity: "good-to-have",
    dashboardPath: "sessions",
    docsUrl: DOCS_SESSIONS,
    feature: FEATURE_LIFETIME,
    ...booleanCheck("session_settings.maximum_lifetime.enabled"),
    patch: ({ config }) => {
      const current = num(config, "session_settings.maximum_lifetime.duration_seconds");
      return {
        session_settings: {
          maximum_lifetime: {
            enabled: true,
            duration_seconds: Math.max(
              current >= MIN_SESSION_SECONDS ? current : DEFAULT_LIFETIME_SECONDS,
              flag(config, "session_settings.inactivity_timeout.enabled")
                ? num(config, "session_settings.inactivity_timeout.duration_seconds") +
                    MIN_SESSION_SECONDS
                : MIN_SESSION_SECONDS,
            ),
          },
        },
      };
    },
  },
  {
    id: "email-link-same-client",
    title: "Email-link same-client requirement",
    description: "Require magic links to be opened on the same device that requested them.",
    severity: "good-to-have",
    dashboardPath: "user-authentication",
    docsUrl: `${DOCS}/secure/best-practices/protect-email-links`,
    appliesTo: ({ config }) => emailEnabled(config),
    ...booleanCheck("auth_attack_protection.email_link_require_same_client"),
    patch: () => ({ auth_attack_protection: { email_link_require_same_client: true } }),
  },
  {
    id: "block-disposable-email",
    title: "Block disposable email domains",
    description: "Reject sign-ups from throwaway email providers.",
    severity: "good-to-have",
    dashboardPath: "user-authentication",
    docsUrl: DOCS_RESTRICTIONS,
    appliesTo: ({ config }) => emailEnabled(config),
    ...booleanCheck("auth_access_control.block_disposable_email_domains"),
    patch: () => ({ auth_access_control: { block_disposable_email_domains: true } }),
  },
  {
    id: "block-email-subaddresses",
    title: "Block email subaddresses",
    description: 'Prevent abuse from "+alias" variations of the same email address.',
    severity: "good-to-have",
    dashboardPath: "user-authentication",
    docsUrl: DOCS_RESTRICTIONS,
    appliesTo: ({ config }) => emailEnabled(config),
    ...booleanCheck("auth_access_control.block_email_subaddresses"),
    patch: () => ({ auth_access_control: { block_email_subaddresses: true } }),
  },
];

export const CHECK_IDS: string[] = CHECKS.map((check) => check.id);

export function findCheck(id: string): CheckDef | undefined {
  return CHECKS.find((check) => check.id === id);
}
