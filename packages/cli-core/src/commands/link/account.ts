import { currentAccount } from "../../lib/claim-prompt.ts";
import { log } from "../../lib/log.ts";
import type { UserInfo } from "../../lib/token-exchange.ts";
import { login } from "../auth/login.ts";

/**
 * The account a person's claim would go to, signing in first when there's no
 * usable session. With `CLERK_PLATFORM_API_KEY` set, the key decides where
 * claims go and authenticates every call, so no sign-in is needed; the
 * session's account, if any, only words messages.
 *
 * Signs in with login's own claim off: `clerk link` applies the claim rule.
 */
export async function signedInAccount(): Promise<UserInfo | null> {
  const account = await currentAccount();
  if (account || process.env.CLERK_PLATFORM_API_KEY) return account;
  log.info("Not logged in. Authenticating first...");
  return login({ showNextSteps: false, claim: false });
}
