import { lookUpAccount } from "../../lib/claim-prompt.ts";
import { log } from "../../lib/log.ts";
import { login } from "../auth/login.ts";

/** The account a claim would go to; no email when it couldn't be looked up. */
export type SignedInAccount = { email?: string };

/**
 * The account a person's claim would go to, signing in first when there's no
 * session. With `CLERK_PLATFORM_API_KEY` set, the key decides where claims go
 * and authenticates every call, so no sign-in is needed; the session's
 * account, if any, only words messages.
 *
 * A session Clerk refused (expired, or rejected by the account lookup) means
 * signing in again, as having none does. A lookup that didn't reach an answer
 * (a network error, a 5xx) still counts as signed in: the account comes back
 * without an email, so messages say "the account you're signed in to".
 * Signing in again then would open a browser, or abort on login's
 * "Re-authenticate?" No.
 *
 * Signs in with login's own claim off: `clerk link` applies the claim rule.
 */
export async function signedInAccount(): Promise<SignedInAccount | null> {
  const lookup = await lookUpAccount();
  if (lookup.status === "account") return lookup.account;
  if (process.env.CLERK_PLATFORM_API_KEY) return null;
  if (lookup.status === "lookup_failed") {
    log.debug("credentials: a session is stored, but its account couldn't be looked up");
    return {};
  }
  log.info("Not logged in. Authenticating first...");
  return login({ showNextSteps: false, claim: false });
}
