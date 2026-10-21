/**
 * User-facing copy for the accountless surface, gathered in one module.
 *
 * One function per sentence (or self-contained message), with everything the
 * sentence interpolates as typed parameters. Commands compose these lines but
 * never author the prose inline — that is the contract that makes
 * localisation possible later: a locale swaps this module's bodies without
 * touching a single call site, and pluralisation/agreement rules live here
 * where a translator can reach them instead of being scattered through
 * command logic.
 *
 * House style every entry carries: backticks highlight commands and
 * identifiers (`lib/log.ts` renders them cyan), and a refusal names the
 * reason and a working alternative rather than just saying no.
 */
/**
 * Whether the secret key's application belongs to a Clerk account, and where
 * the key came from. Any `sk_` key takes the secret-key path, claimed
 * application or not, so a refusal asks Clerk before wording itself
 * (`isClaimedKeylessTarget`): `claimed` is `undefined` when it couldn't. No
 * access at all means an unclaimed application.
 */
export type KeyAccess = { claimed: boolean | undefined; source: string };

const isUnclaimed = (access?: KeyAccess): boolean => !access || access.claimed === false;

const keyTarget = (access?: KeyAccess): string =>
  isUnclaimed(access) ? "for an unclaimed accountless application" : "with only a secret key";

const accountRoute = (source: string): string =>
  "Pass `--app <id> --instance <dev|prod>` (or run `clerk link`), with `clerk auth login` or `CLERK_PLATFORM_API_KEY`. " +
  `A login alone isn't enough while the secret key from ${source} takes precedence.`;

/**
 * The way past a refusal when the application may belong to an account:
 * `cant` completes "a secret key can't …", and `unclaimed` is the advice for
 * an unclaimed one, used only when Clerk couldn't say which it is.
 */
const pastSecretKey = (access: KeyAccess, cant: string, unclaimed: string): string =>
  access.claimed
    ? `This application belongs to a Clerk account, so a secret key can't ${cant}. ${accountRoute(access.source)}`
    : `If this application is unclaimed, ${unclaimed} If it belongs to a Clerk account, a secret key can't ${cant}. ${accountRoute(access.source)}`;

/** Completes "run …" for a claimed application's dashboard link. */
const linkForDashboard = (userId: string): string =>
  `\`clerk link\` (or pass \`--app <id>\`), with \`clerk auth login\` or \`CLERK_PLATFORM_API_KEY\`, then \`clerk users open ${userId}\` will work.`;

const claimForConfig = "run `clerk auth login` to claim it and use the full config document.";

export const keylessCopy = {
  // --- config payload validation (config/keyless.ts) ---

  unsupportedConfigKeys: (
    unknown: string[],
    supported: readonly string[],
    access?: KeyAccess,
  ): string =>
    `Unsupported config ${unknown.length === 1 ? "key" : "keys"} ${keyTarget(access)}: ${unknown.join(", ")}.\n` +
    `Supported keys: ${supported.join(", ")}.` +
    (access && !isUnclaimed(access)
      ? `\n${pastSecretKey(access, `read ${unknown.join(", ")}`, claimForConfig)}`
      : ""),

  unsupportedPayloadKeysLine: (unknown: string[], access?: KeyAccess): string =>
    `Unsupported config ${unknown.length === 1 ? "key" : "keys"} ${keyTarget(access)}: ${unknown.join(", ")}.`,

  supportedPayloadKeysLine: (supported: readonly string[]): string =>
    `Supported top-level keys: ${supported.join(", ")}.`,

  apiReachableKeysLine: (keys: string[], access?: KeyAccess): string =>
    `${keys.join(", ")} ${keys.length === 1 ? "is" : "are"} already reachable ${isUnclaimed(access) ? "on an unclaimed application" : "with the secret key"} — use ${keys.map((key) => `\`clerk api /${key}\``).join(" or ")} directly instead of this config document.`,

  claimForFullConfigLine: (keys: string[], access?: KeyAccess): string =>
    access && !isUnclaimed(access)
      ? pastSecretKey(access, `change ${keys.join(", ")}`, claimForConfig)
      : "Run `clerk auth login` to claim the application and use the full config document.",

  configKeyMustBeObject: (key: string): string => `Config key \`${key}\` must be a JSON object.`,

  unsupportedInstanceFieldsLine: (unknown: string[], access?: KeyAccess): string =>
    `Unsupported ${unknown.length === 1 ? "field" : "fields"} on \`instance\` ${keyTarget(access)}: ${unknown.join(", ")}.`,

  supportedInstanceFieldsLine: (fields: readonly string[]): string =>
    `Supported fields: ${fields.join(", ")}.`,

  noRouteForInstanceFieldLine: (reason: string, access?: KeyAccess): string =>
    isUnclaimed(access)
      ? `Clerk's Backend API has no route for ${reason}, so this can't be changed from an unclaimed application at all — claim it first with \`clerk auth login\`.`
      : `Clerk's Backend API has no route for ${reason}.`,

  /** Closes an instance-field refusal when the application may belong to an account. */
  secretKeyCantChangeLine: (fields: string[], access: KeyAccess): string =>
    pastSecretKey(
      access,
      `change ${fields.join(", ")}`,
      "run `clerk auth login` to claim it first.",
    ),

  /** A keyless pull of an application that belongs to an account: what it left out, and how to get it. */
  pullCoversLessForClaimed: (groups: readonly string[], source: string): string =>
    `This application belongs to a Clerk account, but the secret key from ${source} only reads ${groups.join(", ")}; the rest of its config is left out.\n` +
    accountRoute(source),

  // --- "needs a claimed application" refusals ---

  billingNeedsClaimedApplication: (access?: KeyAccess): string =>
    access && !isUnclaimed(access)
      ? "Billing lives in the account-level config document — Clerk's Backend API has no billing settings.\n" +
        pastSecretKey(
          access,
          "configure billing",
          "run `clerk auth login` to claim it, then re-run the command.",
        )
      : "Billing can only be configured on a claimed application — Clerk's Backend API has no billing settings, so an unclaimed accountless application can't reach them.\n" +
        "Run `clerk auth login` to claim this application, then re-run the command.",

  schemaNeedsClaimedApplication: (access?: KeyAccess): string =>
    access && !isUnclaimed(access)
      ? "Config schema describes the account-level config document.\n" +
        pastSecretKey(
          access,
          "read the config schema",
          "run `clerk auth login` to claim it, then re-run `clerk config schema`.",
        )
      : "Config schema is only available for a claimed application — the schema describes the account-level config document, which an unclaimed accountless application has no access to.\n" +
        "Run `clerk auth login` to claim this application, then re-run `clerk config schema`.",

  putNeedsClaimedApplication: (access?: KeyAccess): string =>
    access && !isUnclaimed(access)
      ? "Replacing the entire configuration needs the account-level config document.\n" +
        pastSecretKey(
          access,
          "replace the whole config",
          "run `clerk auth login` to claim it first.",
        ) +
        "\nOr use `clerk config patch` for the settings a secret key reaches."
      : "Replacing the entire configuration is only available for a claimed application — an unclaimed accountless application has no full config document to replace.\n" +
        "Use `clerk config patch` to update individual settings, or run `clerk auth login` to claim the application first.",

  instanceFlagWithKey: (source: string, access?: KeyAccess): string =>
    access && !isUnclaimed(access)
      ? `--instance is not supported with only a secret key: the key in ${source} already targets its own instance.\n` +
        pastSecretKey(
          access,
          "pick another instance",
          "run `clerk auth login` to claim it, then target instances by name.",
        )
      : `--instance is not supported for an unclaimed accountless application: the secret key in ${source} already targets its own instance.\n` +
        "Run `clerk auth login` to claim the application, then target instances by name.",

  userDashboardNeedsClaim: (userId: string, access: KeyAccess): string =>
    (access.claimed === false
      ? `The secret key from ${access.source} belongs to an unclaimed accountless application, which has no Dashboard page — a dashboard link needs an application ID, and one is only assigned when the application is claimed.\n` +
        `Run \`clerk auth login\` to claim it, then \`clerk users open ${userId}\` will work.\n`
      : access.claimed
        ? `This application belongs to a Clerk account, but a dashboard link needs its application ID, which the secret key from ${access.source} doesn't carry.\n` +
          `Run ${linkForDashboard(userId)}\n`
        : `A dashboard link needs an application ID, which the secret key from ${access.source} doesn't carry.\n` +
          `If this application is unclaimed, run \`clerk auth login\` to claim it. If it belongs to a Clerk account, run ${linkForDashboard(userId)}\n`) +
    `To inspect the user right now, \`clerk api /users/${userId}\` reads it straight from the instance.`,
};
