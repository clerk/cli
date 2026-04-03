import { getToken } from "../../lib/credential-store.ts";
import { fetchUserInfo } from "../../lib/token-exchange.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";

export async function whoami() {
  const token = await getToken();
  if (!token) {
    log.data("Not logged in. Run `clerk auth login` to authenticate");
    return;
  }

  try {
    const userInfo = await withSpinner("Fetching account info...", () => fetchUserInfo(token));
    log.data(userInfo.email);
  } catch {
    log.data("Session expired. Run `clerk auth login` to re-authenticate");
    return;
  }
}
