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
 * What a refusal says the folder's secret key reaches. Only an app `clerk init`
 * or a Clerk SDK created is called unclaimed: plain keys may belong to an app
 * already in an account, so they're named by their file.
 */
export interface KeylessSubject {
  unclaimed: boolean;
  /** Where the secret key came from, e.g. `.env`. */
  source: string;
}

/** "for an unclaimed accountless application", or the condition plain keys are in. */
const forApp = (subject: KeylessSubject): string =>
  subject.unclaimed ? "for an unclaimed accountless application" : "without a linked application";

/** The kind of app a refusal needs: claimed, or for plain keys, linked. */
const needed = (subject: KeylessSubject): string =>
  subject.unclaimed ? "a claimed application" : "a linked application";

/** What can't reach the account-level settings. */
const reacher = (subject: KeylessSubject): string =>
  subject.unclaimed
    ? "an unclaimed accountless application"
    : `the secret key from \`${subject.source}\``;

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

export const keylessCopy = {
  // --- config payload validation (config/keyless.ts) ---

  unsupportedConfigKeys: (
    unknown: string[],
    supported: readonly string[],
    subject: KeylessSubject,
  ): string =>
    `Unsupported config ${plural(unknown.length, "key", "keys")} ${forApp(subject)}: ${unknown.join(", ")}.\n` +
    `Supported keys: ${supported.join(", ")}.`,

  unsupportedPayloadKeysLine: (unknown: string[], subject: KeylessSubject): string =>
    `Unsupported config ${plural(unknown.length, "key", "keys")} ${forApp(subject)}: ${unknown.join(", ")}.`,

  supportedPayloadKeysLine: (supported: readonly string[]): string =>
    `Supported top-level keys: ${supported.join(", ")}.`,

  apiReachableKeysLine: (keys: string[], subject: KeylessSubject): string =>
    `${keys.join(", ")} ${plural(keys.length, "is", "are")} already reachable ${subject.unclaimed ? "on an unclaimed application" : `through the secret key from \`${subject.source}\``} — use ${keys.map((key) => `\`clerk api /${key}\``).join(" or ")} directly instead of this config document.`,

  /** `step` is the step for what the folder holds (`unlinkedFolderNextStep`). */
  linkForFullConfigLine: (step: string): string =>
    `The full config document needs a linked application. ${step}`,

  configKeyMustBeObject: (key: string): string => `Config key \`${key}\` must be a JSON object.`,

  unsupportedInstanceFieldsLine: (unknown: string[], subject: KeylessSubject): string =>
    `Unsupported ${plural(unknown.length, "field", "fields")} on \`instance\` ${forApp(subject)}: ${unknown.join(", ")}.`,

  supportedInstanceFieldsLine: (fields: readonly string[]): string =>
    `Supported fields: ${fields.join(", ")}.`,

  noRouteForInstanceFieldLine: (reason: string, subject: KeylessSubject): string =>
    `Clerk's Backend API has no route for ${reason}, so this can't be changed ${subject.unclaimed ? "from an unclaimed application at all" : "without a linked application"}.`,

  // --- "needs a claimed application" refusals; `step` as above ---

  billingNeedsClaimedApplication: (subject: KeylessSubject, step: string): string =>
    `Billing can only be configured on ${needed(subject)} — Clerk's Backend API has no billing settings, so ${reacher(subject)} can't reach them.\n${step}`,

  schemaNeedsClaimedApplication: (subject: KeylessSubject, step: string): string =>
    `Config schema is only available for ${needed(subject)} — the schema describes the account-level config document, which ${reacher(subject)} has no access to.\n${step}`,

  putNeedsClaimedApplication: (subject: KeylessSubject, step: string): string =>
    `Replacing the entire configuration is only available for ${needed(subject)} — ${reacher(subject)} has no full config document to replace.\n` +
    `Use \`clerk config patch\` to update individual settings, or link the app first. ${step}`,

  userDashboardNeedsClaim: (subject: KeylessSubject, userId: string, step: string): string =>
    (subject.unclaimed
      ? `This directory holds an unclaimed accountless application (secret key from ${subject.source}), which has no Dashboard page — a dashboard link needs an application ID, and one is only assigned when the application is claimed.\n`
      : `This directory isn't linked, so the CLI doesn't know the ID of the application the secret key from ${subject.source} belongs to, and a Dashboard link needs it.\n`) +
    `${step}\n` +
    `To inspect the user right now, \`clerk api /users/${userId}\` reads it straight from the instance.`,

  /**
   * `step` as above, with its rerun of `clerk env pull`. `skipped`: a generic
   * key line the framework doesn't read, as "`CLERK_PUBLISHABLE_KEY` in .env.local".
   */
  missingPublishableKey: (
    publishableKeyName: string,
    step: string,
    skipped?: { line: string; framework: string },
  ): string =>
    skipped
      ? `No publishable key found locally. ${skipped.line} isn't read by ${skipped.framework}: rename it to \`${publishableKeyName}\`, or link this folder's app to pull the key. ${step}`
      : `No publishable key found locally. Set ${publishableKeyName} manually, or link this folder's app to pull it. ${step}`,

  instanceFlagNeedsLinkedApplication: (subject: KeylessSubject, step: string): string =>
    `--instance is not supported ${forApp(subject)}: the secret key in ${subject.source} already targets its own instance.\n` +
    `${step} Then target instances by name.`,
};
