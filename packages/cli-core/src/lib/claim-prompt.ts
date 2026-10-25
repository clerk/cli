/**
 * The question a person answers before the CLI claims the app `clerk init`
 * created, and the wording for where the claim goes. Every claim a person
 * triggers is asked about first, naming the destination the claim will
 * actually use; one helper keeps every command that claims asking the same
 * way. Agents can't answer, so they claim without it.
 */

import { getAuth } from "./config.ts";
import { getValidToken } from "./credential-store.ts";
import { isAuthError } from "./errors.ts";
import { confirm } from "./prompts.ts";
import { fetchUserInfo, type UserInfo } from "./token-exchange.ts";

/**
 * The account the stored session belongs to, or null when there's no session
 * the CLI can use: none stored, one that can't be refreshed, or account info
 * that couldn't be fetched. Network errors count as "no session", never a
 * failure: callers sign in again instead.
 */
export async function currentAccount(): Promise<UserInfo | null> {
  const lookup = await lookUpAccount();
  return lookup.status === "account" ? lookup.account : null;
}

/**
 * What looking up the stored session's account found:
 *
 * - `account`: the session works, and this is its account.
 * - `signed_out`: no session, or one Clerk refused (it expired and can't be
 *   refreshed, or the account lookup answered 401 or 403). Only signing in
 *   again fixes it.
 * - `lookup_failed`: the lookup didn't reach an answer (a network error, a
 *   5xx, a timeout). The session may well still work.
 */
export type AccountLookup =
  | { status: "account"; account: UserInfo }
  | { status: "signed_out" }
  | { status: "lookup_failed" };

/** `currentAccount`, telling a refused session apart from a failed lookup. */
export async function lookUpAccount(): Promise<AccountLookup> {
  const auth = await getAuth();
  if (!auth) return { status: "signed_out" };

  try {
    const token = await getValidToken();
    if (!token) return { status: "signed_out" };
    return { status: "account", account: await fetchUserInfo(token) };
  } catch (error) {
    // The refresh step throws `AuthError` for a session it can't refresh (a
    // spent or refused refresh token, or a stored value it can't read); the
    // account lookup answers 401 or 403 for a token it won't accept.
    return isAuthError(error) ? { status: "signed_out" } : { status: "lookup_failed" };
  }
}

/**
 * Where a claim made now would put the app. `CLERK_PLATFORM_API_KEY`, when
 * set, authenticates every Platform API call (`getAuthToken` in `plapi.ts`),
 * the claim included, so it decides even when a person is also signed in.
 */
export type ClaimDestination = { kind: "api_key" } | { kind: "account"; email?: string };

/**
 * The destination for a claim made now, given the stored session's account
 * (null without one). Undefined when neither credential exists: no claim can
 * go anywhere the person was told about, so callers don't claim.
 *
 * Whether a session exists decides; its email only shapes the wording, since
 * nothing checks that Clerk's account-info reply includes one.
 */
export function claimDestination(
  account: { email?: string } | null | undefined,
): ClaimDestination | undefined {
  if (process.env.CLERK_PLATFORM_API_KEY) return { kind: "api_key" };
  return account ? { kind: "account", email: account.email || undefined } : undefined;
}

/**
 * "jane@example.com's account", or the API key's workspace. The email names
 * the person, not which of their workspaces gets the app: a session's claim
 * lands in the workspace that sign-in used.
 */
export function describeClaimDestination(destination: ClaimDestination): string {
  if (destination.kind === "api_key")
    return "the workspace your `CLERK_PLATFORM_API_KEY` belongs to";
  return destination.email ? `${destination.email}'s account` : "the account you're signed in to";
}

/**
 * Asks whether to claim `appName` into `destination`; defaults to Yes.
 * `offerSignInAsSomeoneElse` adds that No signs in again first. Only offer it
 * when that is what No does, and never for the API key's workspace: signing in
 * again wouldn't change where the claim goes.
 */
export async function confirmClaim({
  appName,
  destination,
  offerSignInAsSomeoneElse = false,
}: {
  appName: string;
  destination: ClaimDestination;
  offerSignInAsSomeoneElse?: boolean;
}): Promise<boolean> {
  const offer =
    offerSignInAsSomeoneElse && destination.kind === "account"
      ? " No signs you in as someone else first."
      : "";
  return confirm({
    message: `Claim \`${appName}\` (the app \`clerk init\` created in this folder) into ${describeClaimDestination(destination)}?${offer}`,
    default: true,
  });
}
