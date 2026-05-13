import { getValidToken } from "../../lib/credential-store.ts";
import { fetchUserInfo } from "../../lib/token-exchange.ts";
import { withSpinner, intro, outro } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";
import { AuthError } from "../../lib/errors.ts";
import { resolveProfile } from "../../lib/config.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";

export async function whoami() {
  const token = await getValidToken();
  if (!token) {
    throw new AuthError({ reason: "not_logged_in" });
  }

  intro("Identifying user");

  let userInfo;
  try {
    userInfo = await withSpinner("Fetching account info...", () => fetchUserInfo(token));
  } catch {
    throw new AuthError({ reason: "session_expired" });
  }

  log.data(userInfo.email);

  let isLinked = false;
  try {
    isLinked = Boolean(await resolveProfile(process.cwd()));
  } catch {
    // Best-effort only: don't fail whoami when local profile resolution fails.
  }
  outro(isLinked ? NEXT_STEPS.WHOAMI_LINKED : NEXT_STEPS.WHOAMI);
}
