/**
 * Clerk destination configs (D1–D5 in .testing-plan.md), each a
 * `clerk config patch` body. Every one sets all four keys, so applying one
 * fully replaces whatever the previous run left behind.
 */
export const DEST_KEYS = ["auth_email", "auth_phone", "auth_username", "auth_password"] as const;

export const email = (required: boolean) => ({
  used_for_sign_up: true,
  used_for_sign_in: true,
  required_for_sign_up: required,
  sign_in_strategies: ["email_code"],
  verification_strategies: ["email_code"],
});
export const phone = (required: boolean) => ({
  used_for_sign_up: true,
  used_for_sign_in: true,
  required_for_sign_up: required,
  sign_in_strategies: ["phone_code"],
  verification_strategies: ["phone_code"],
});
export const phoneOff = {
  used_for_sign_up: false,
  used_for_sign_in: false,
  required_for_sign_up: false,
  sign_in_strategies: [],
  verification_strategies: [],
};
export const username = (on: boolean, required = false, extended = false) => ({
  used_for_sign_up: on,
  used_for_sign_in: on,
  required_for_sign_up: required,
  allow_extended_special_characters: extended,
});

export const DESTS = {
  /**
   * Everything on, nothing required: every valid user imports. Extended
   * username characters are on so dotted usernames (common in every source)
   * land; D2–D4 keep Clerk's default and so exercise that rejection.
   */
  D1: {
    auth_email: email(false),
    auth_phone: phone(false),
    auth_username: username(true, false, true),
    auth_password: { enabled: true, required: false },
  },
  /** Email + password required: phone-only and passwordless users are rejected. */
  D2: {
    auth_email: email(true),
    auth_phone: phone(false),
    auth_username: username(true),
    auth_password: { enabled: true, required: true },
  },
  /** Phone required: email-only users are rejected. */
  D3: {
    auth_email: email(false),
    auth_phone: phone(true),
    auth_username: username(true),
    auth_password: { enabled: true, required: false },
  },
  /** Username required: users without one are rejected. */
  D4: {
    auth_email: email(false),
    auth_phone: phone(false),
    auth_username: username(true, true),
    auth_password: { enabled: true, required: false },
  },
  /** Email code only (the dev instance's original config): passwords dropped. */
  D5: {
    auth_email: email(true),
    auth_phone: phoneOff,
    auth_username: username(false),
    auth_password: { enabled: false, required: false },
  },
} as const;

export type DestId = keyof typeof DESTS;

/**
 * Settings every eval run applies with its config, so the pool targets match
 * whatever their dashboards were left at. Nothing here changes which users
 * import; it keeps the instances alike. When eval:ready reports a setting
 * differing between targets, add it here.
 */
export const EVAL_BASELINE = {
  auth_biometric: {
    used_for_sign_in: false,
    enrollment_prompt_after_sign_in: false,
    enrollment_prompt_after_sign_up: false,
  },
} as const;

/** A config patch with the eval baseline applied. */
export const withBaseline = (body: object) => ({ ...EVAL_BASELINE, ...body });

/**
 * A config that turns on what `users` hold (phone, username, password) and
 * requires nothing, so every valid user can land. Users with `skip` are ignored.
 */
export function configForUsers(
  users: {
    skip?: string;
    phones: string[];
    unverifiedPhones: string[];
    username?: string;
    hasPassword: boolean;
  }[],
) {
  const live = users.filter((u) => !u.skip);
  const usernames = live.flatMap((u) => (u.username ? [u.username] : []));
  return {
    auth_email: email(false),
    auth_phone: live.some((u) => u.phones.length || u.unverifiedPhones.length)
      ? phone(false)
      : phoneOff,
    auth_username: username(
      usernames.length > 0,
      false,
      usernames.some((u) => !/^[a-z0-9_-]+$/i.test(u)),
    ),
    auth_password: { enabled: live.some((u) => u.hasPassword), required: false },
  };
}
export const DEST_IDS = Object.keys(DESTS) as DestId[];
