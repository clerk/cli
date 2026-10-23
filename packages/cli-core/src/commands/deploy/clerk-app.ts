import {
  CliError,
  ERROR_CODE,
  errorMessage,
  PlapiError,
  UserAbortError,
} from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { checkClerkAppSlug, type ClerkAppSlugCheck } from "../../lib/plapi.ts";
import { CLERK_APP_SLUG_FORMAT } from "./errors.ts";

const CLERK_APP_SUFFIX = ".clerk.app";
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export type ClerkAppSlug = string & { readonly __brand: "ClerkAppSlug" };

export type ProductionDomainChoice =
  | { kind: "own"; domain: string }
  | { kind: "clerk_app"; slug: ClerkAppSlug }
  /** A hosting domain such as acme.vercel.app, added beside the `<slug>.clerk.app` primary. */
  | { kind: "hosting"; domain: string; slug: ClerkAppSlug };

export type ClerkAppOffer =
  | { enabled: false }
  | { enabled: true; suggestion: ClerkAppSlug | undefined };

export function parseClerkAppSlug(
  raw: string,
): { ok: true; slug: ClerkAppSlug } | { ok: false; message: string } {
  let value = raw.trim().toLowerCase();
  if (value.endsWith(CLERK_APP_SUFFIX)) value = value.slice(0, -CLERK_APP_SUFFIX.length);
  if (!SLUG_PATTERN.test(value)) return { ok: false, message: CLERK_APP_SLUG_FORMAT };
  return { ok: true, slug: value as ClerkAppSlug };
}

export function clerkAppDomain(slug: ClerkAppSlug): string {
  return `${slug}${CLERK_APP_SUFFIX}`;
}

/**
 * The app name as a slug to check. The check answers a name that is too short
 * or taken with a free suggestion, so this only makes it fit in a URL path.
 */
export function slugCandidate(appLabel: string): string {
  const candidate = appLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 63)
    .replace(/^-+|-+$/g, "");
  return candidate || "app";
}

function toSlug(raw: string | null): ClerkAppSlug | undefined {
  if (!raw) return undefined;
  const parsed = parseClerkAppSlug(raw);
  return parsed.ok ? parsed.slug : undefined;
}

type SlugCheckResult =
  | { kind: "disabled" }
  | { kind: "invalid"; suggestion: ClerkAppSlug | undefined }
  | { kind: "taken"; suggestion: ClerkAppSlug | undefined }
  | { kind: "available" };

function classifySlugCheck(check: ClerkAppSlugCheck): SlugCheckResult {
  if (!check.enabled) return { kind: "disabled" };
  const suggestion = toSlug(check.suggestion);
  if (!check.valid) return { kind: "invalid", suggestion };
  if (!check.available) return { kind: "taken", suggestion };
  return { kind: "available" };
}

export async function probeClerkApp(appId: string, appLabel: string): Promise<ClerkAppOffer> {
  const candidate = slugCandidate(appLabel);
  try {
    const result = classifySlugCheck(await checkClerkAppSlug(appId, candidate));
    if (result.kind === "disabled") return { enabled: false };
    if (result.kind === "available") return { enabled: true, suggestion: toSlug(candidate) };
    return { enabled: true, suggestion: result.suggestion };
  } catch (error) {
    if (error instanceof UserAbortError) throw error;
    log.debug(`deploy: clerk.app check failed, not offering it: ${errorMessage(error)}`);
    return { enabled: false };
  }
}

export type SlugTaken = { message: string; suggestion: ClerkAppSlug | undefined };

function takenMessage(slug: ClerkAppSlug, suggestion: ClerkAppSlug | undefined): string {
  const tryNext = suggestion ? `Try ${suggestion}.` : "Try another name.";
  return `${clerkAppDomain(slug)} is taken. ${tryNext}`;
}

function invalidMessage(suggestion: ClerkAppSlug | undefined): string {
  return suggestion ? `${CLERK_APP_SLUG_FORMAT} Try ${suggestion}.` : CLERK_APP_SLUG_FORMAT;
}

export const CLERK_APP_NOT_ENABLED =
  "Free clerk.app domains aren't available for this application yet. " +
  "No production instance was created. Run `clerk deploy` without --clerk-app to use a domain you own.";

/** A PLAPI without the check route predates clerk.app, so it counts as clerk.app off. */
async function checkSlugStrictly(appId: string, slug: string): Promise<SlugCheckResult> {
  const check = await checkClerkAppSlug(appId, slug).catch((error: unknown) => {
    if (error instanceof PlapiError && error.status === 404) return undefined;
    throw error;
  });
  return check ? classifySlugCheck(check) : { kind: "disabled" };
}

/**
 * The clerk.app name for an app on a hosting domain, as the Clerk Dashboard
 * prefills it: the host's first label, or the check's suggestion when that is
 * taken.
 */
export async function hostingDomainOffer(appId: string, host: string): Promise<ClerkAppOffer> {
  const candidate = slugCandidate(host.split(".")[0] ?? "");
  const result = await checkSlugStrictly(appId, candidate);
  if (result.kind === "disabled") return { enabled: false };
  if (result.kind === "available") return { enabled: true, suggestion: toSlug(candidate) };
  return { enabled: true, suggestion: result.suggestion };
}

/**
 * Throws unless PLAPI confirms clerk.app is on and the name is free. A PLAPI
 * without clerk.app ignores `clerk_app_slug` and creates production on a
 * random placeholder domain, so `--clerk-app` must never create unconfirmed.
 */
export async function requireClerkAppSlug(appId: string, slug: ClerkAppSlug): Promise<void> {
  const result = await checkSlugStrictly(appId, slug);
  switch (result.kind) {
    case "disabled":
      throw new CliError(CLERK_APP_NOT_ENABLED, { code: ERROR_CODE.CLERK_APP_NOT_ENABLED });
    case "invalid":
      throw new CliError(invalidMessage(result.suggestion), {
        code: ERROR_CODE.CLERK_APP_SLUG_INVALID,
      });
    case "taken":
      throw new CliError(takenMessage(slug, result.suggestion), {
        code: ERROR_CODE.CLERK_APP_SLUG_UNAVAILABLE,
      });
    case "available":
      return;
  }
}

const CLERK_APP_WITHDRAWN =
  "Free clerk.app domains aren't available for this application anymore. " +
  "No production instance was created. Run `clerk deploy` again to use a domain you own.";

/** Undefined when the name is free, or when the check itself failed and create should decide. */
export async function checkSlugTaken(
  appId: string,
  slug: ClerkAppSlug,
): Promise<SlugTaken | undefined> {
  let result: SlugCheckResult;
  try {
    result = classifySlugCheck(await checkClerkAppSlug(appId, slug));
  } catch (error) {
    if (error instanceof UserAbortError) throw error;
    log.debug(`deploy: clerk.app availability check failed: ${errorMessage(error)}`);
    return undefined;
  }
  switch (result.kind) {
    case "disabled":
      throw new CliError(CLERK_APP_WITHDRAWN, { code: ERROR_CODE.CLERK_APP_NOT_ENABLED });
    case "invalid":
      return { message: invalidMessage(result.suggestion), suggestion: result.suggestion };
    case "taken":
      return { message: takenMessage(slug, result.suggestion), suggestion: result.suggestion };
    case "available":
      return undefined;
  }
}
