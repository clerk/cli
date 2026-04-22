import { getValidToken } from "../../lib/credential-store.ts";
import { fetchUserInfo } from "../../lib/token-exchange.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";
import { AuthError } from "../../lib/errors.ts";

export async function whoami() {
  const token = await getValidToken();
  if (!token) {
    throw new AuthError({ reason: "not_logged_in" });
  }

  try {
    const userInfo = await withSpinner("Fetching account info...", () => fetchUserInfo(token));
    log.data(userInfo.email);
  } catch {
    throw new AuthError({ reason: "session_expired" });
  }
}
