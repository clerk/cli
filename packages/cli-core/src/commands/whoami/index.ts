import { getValidToken } from "../../lib/credential-store.ts";
import { fetchUserInfo } from "../../lib/token-exchange.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";
import { AuthError } from "../../lib/errors.ts";
import { resolveProfile } from "../../lib/config.ts";
import { NEXT_STEPS, printNextSteps } from "../../lib/next-steps.ts";

export async function whoami() {
  const token = await getValidToken();
  if (!token) {
    throw new AuthError({ reason: "not_logged_in" });
  }

  let userInfo;
  try {
    userInfo = await withSpinner("Fetching account info...", () => fetchUserInfo(token));
  } catch {
    throw new AuthError({ reason: "session_expired" });
  }
  log.data(userInfo.email);

  const profile = await resolveProfile(process.cwd());
  printNextSteps(profile ? NEXT_STEPS.WHOAMI_LINKED : NEXT_STEPS.WHOAMI);
}
