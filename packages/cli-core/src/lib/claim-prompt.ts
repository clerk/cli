/**
 * The question a person answers before the CLI claims the app `clerk init`
 * created, and the wording for where the claim goes. Every claim a person
 * triggers is asked about first, naming the destination the claim will
 * actually use; one helper keeps every command that claims asking the same
 * way. Agents can't answer, so they claim without it.
 */

import { confirm } from "./prompts.ts";

/**
 * Where a claim made now would put the app. `CLERK_PLATFORM_API_KEY`, when
 * set, authenticates every Platform API call (`getAuthToken` in `plapi.ts`),
 * the claim included, so it decides even when a person is also signed in.
 */
export type ClaimDestination = { kind: "api_key" } | { kind: "account"; email: string };

/**
 * The destination for a claim made now by the account `email` signed into.
 * Undefined when neither credential names one: no claim can go anywhere the
 * person was told about, so callers don't claim.
 */
export function claimDestination(email: string | undefined): ClaimDestination | undefined {
  if (process.env.CLERK_PLATFORM_API_KEY) return { kind: "api_key" };
  return email ? { kind: "account", email } : undefined;
}

/** "jane@example.com's account", or the API key's workspace. */
export function describeClaimDestination(destination: ClaimDestination): string {
  return destination.kind === "api_key"
    ? "the workspace your `CLERK_PLATFORM_API_KEY` belongs to"
    : `${destination.email}'s account`;
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
