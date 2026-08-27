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
export const keylessCopy = {
  // --- config payload validation (config/keyless.ts) ---

  unsupportedConfigKeys: (unknown: string[], supported: readonly string[]): string =>
    `Unsupported config ${unknown.length === 1 ? "key" : "keys"} for an unclaimed accountless application: ${unknown.join(", ")}.\n` +
    `Supported keys: ${supported.join(", ")}.`,

  unsupportedPayloadKeysLine: (unknown: string[]): string =>
    `Unsupported config ${unknown.length === 1 ? "key" : "keys"} for an unclaimed accountless application: ${unknown.join(", ")}.`,

  supportedPayloadKeysLine: (supported: readonly string[]): string =>
    `Supported top-level keys: ${supported.join(", ")}.`,

  apiReachableKeysLine: (keys: string[]): string =>
    `${keys.join(", ")} ${keys.length === 1 ? "is" : "are"} already reachable on an unclaimed application — use ${keys.map((key) => `\`clerk api /${key}\``).join(" or ")} directly instead of this config document.`,

  claimForFullConfigLine: (): string =>
    "Run `clerk auth login` to claim the application and use the full config document.",

  configKeyMustBeObject: (key: string): string => `Config key \`${key}\` must be a JSON object.`,

  unsupportedInstanceFieldsLine: (unknown: string[]): string =>
    `Unsupported ${unknown.length === 1 ? "field" : "fields"} on \`instance\` for an unclaimed accountless application: ${unknown.join(", ")}.`,

  supportedInstanceFieldsLine: (fields: readonly string[]): string =>
    `Supported fields: ${fields.join(", ")}.`,

  noRouteForInstanceFieldLine: (reason: string): string =>
    `Clerk's Backend API has no route for ${reason}, so this can't be changed from an unclaimed application at all — claim it first with \`clerk auth login\`.`,

  // --- "needs a claimed application" refusals ---

  billingNeedsClaimedApplication: (): string =>
    "Billing can only be configured on a claimed application — Clerk's Backend API has no billing settings, so an unclaimed accountless application can't reach them.\n" +
    "Run `clerk auth login` to claim this application, then re-run the command.",

  schemaNeedsClaimedApplication: (): string =>
    "Config schema is only available for a claimed application — the schema describes the account-level config document, which an unclaimed accountless application has no access to.\n" +
    "Run `clerk auth login` to claim this application, then re-run `clerk config schema`.",

  putNeedsClaimedApplication: (): string =>
    "Replacing the entire configuration is only available for a claimed application — an unclaimed accountless application has no full config document to replace.\n" +
    "Use `clerk config patch` to update individual settings, or run `clerk auth login` to claim the application first.",

  userDashboardNeedsClaim: (keySource: string, userId: string): string =>
    `This directory holds an unclaimed accountless application (secret key from ${keySource}), which has no Dashboard page — a dashboard link needs an application ID, and one is only assigned when the application is claimed.\n` +
    `Run \`clerk auth login\` to claim it, then \`clerk users open ${userId}\` will work.\n` +
    `To inspect the user right now, \`clerk api /users/${userId}\` reads it straight from the instance.`,
};
