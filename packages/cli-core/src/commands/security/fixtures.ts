// Test-only documents covering every group the catalog reads.

import type { InstanceConfig } from "./types.ts";

export const SECURE_CONFIG: InstanceConfig = {
  auth_attack_protection: {
    bot_protection: { captcha_enabled: true, captcha_widget_type: "smart" },
    email_link_require_same_client: true,
    enumeration_protection: "bulk",
    pii_protection_enabled: true,
    user_lockout: { enabled: true, max_attempts: 10, duration_in_minutes: 60 },
  },
  auth_password: {
    enabled: true,
    required: true,
    device_trust: { enabled: true },
    disable_hibp: false,
    enforce_hibp_on_sign_in: true,
    min_length: 12,
    max_length: 0,
    min_zxcvbn_strength: 3,
    show_zxcvbn: true,
  },
  auth_multi_factor: {
    authenticator_app: { enabled: true },
    backup_code: { enabled: true },
    required_for_sign_in: true,
    required_for_sign_up: true,
  },
  auth_email: {
    used_for_sign_up: true,
    used_for_sign_in: true,
    required_for_sign_up: true,
    verify_at_sign_up: true,
    sign_in_strategies: ["email_code"],
    verification_strategies: ["email_code"],
  },
  auth_phone: {
    used_for_sign_up: true,
    used_for_sign_in: true,
    used_for_second_factor: true,
    verify_at_sign_up: true,
    sign_in_strategies: ["phone_code"],
    second_factor_strategies: ["phone_code"],
    verification_strategies: ["phone_code"],
  },
  auth_passkey: { used_for_sign_in: true, satisfies_second_factor: true },
  auth_web3: { used_for_sign_in: false, sign_in_strategies: [] },
  auth_access_control: {
    allowlist_enabled: true,
    blocklist_enabled: false,
    allowlist_blocklist_enforced_on_sign_in: true,
    block_disposable_email_domains: true,
    block_email_subaddresses: true,
    sign_up_mode: "public",
  },
  session_settings: {
    inactivity_timeout: { enabled: true, duration_seconds: 1800 },
    maximum_lifetime: { enabled: true, duration_seconds: 604800 },
    multi_session_enabled: false,
  },
  connection_oauth_google: { enabled: true, client_id: "custom-id", client_secret: "***" },
  connection_oauth_github: { enabled: false, client_id: "", client_secret: "" },
};

export const INSECURE_CONFIG: InstanceConfig = {
  auth_attack_protection: {
    bot_protection: { captcha_enabled: false, captcha_widget_type: "smart" },
    email_link_require_same_client: false,
    enumeration_protection: "bulk",
    pii_protection_enabled: false,
    user_lockout: { enabled: false, max_attempts: 50, duration_in_minutes: 0 },
  },
  auth_password: {
    enabled: true,
    required: true,
    device_trust: { enabled: false },
    disable_hibp: true,
    enforce_hibp_on_sign_in: false,
    min_length: 6,
    max_length: 0,
    min_zxcvbn_strength: 0,
    show_zxcvbn: false,
  },
  auth_multi_factor: {
    authenticator_app: { enabled: false },
    backup_code: { enabled: false },
    required_for_sign_in: false,
    required_for_sign_up: false,
  },
  auth_email: {
    used_for_sign_up: true,
    used_for_sign_in: true,
    required_for_sign_up: true,
    verify_at_sign_up: false,
    sign_in_strategies: [],
    verification_strategies: [],
  },
  auth_phone: {
    used_for_sign_up: true,
    used_for_sign_in: false,
    used_for_second_factor: false,
    verify_at_sign_up: false,
    sign_in_strategies: [],
    second_factor_strategies: [],
    verification_strategies: [],
  },
  auth_passkey: { used_for_sign_in: false, satisfies_second_factor: false },
  auth_web3: { used_for_sign_in: false, sign_in_strategies: [] },
  auth_access_control: {
    allowlist_enabled: true,
    blocklist_enabled: false,
    allowlist_blocklist_enforced_on_sign_in: false,
    block_disposable_email_domains: false,
    block_email_subaddresses: false,
    sign_up_mode: "public",
  },
  session_settings: {
    inactivity_timeout: { enabled: false, duration_seconds: 0 },
    maximum_lifetime: { enabled: false, duration_seconds: 0 },
    multi_session_enabled: true,
  },
  connection_oauth_google: { enabled: false, client_id: "", client_secret: "" },
  connection_oauth_github: { enabled: false, client_id: "", client_secret: "" },
};

// Enabling a provider satisfies passwordless, so the OAuth check gets its own document.
export const INSECURE_OAUTH_CONFIG: InstanceConfig = {
  ...INSECURE_CONFIG,
  connection_oauth_google: { enabled: true, client_id: "", client_secret: "" },
};
