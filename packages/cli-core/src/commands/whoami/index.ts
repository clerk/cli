import { getValidToken } from "../../lib/credential-store.ts";
import { fetchUserInfo } from "../../lib/token-exchange.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";

export async function whoami() {
  const token = await getValidToken();
  if (!token) {
    throw new CliError("Not logged in. Run `clerk auth login` to authenticate", {
      code: ERROR_CODE.AUTH_REQUIRED,
    });
  }

  try {
    const userInfo = await withSpinner("Fetching account info...", () => fetchUserInfo(token));
    log.data(userInfo.email);
  } catch {
    throw new CliError("Session expired. Run `clerk auth login` to re-authenticate", {
      code: ERROR_CODE.AUTH_REQUIRED,
    });
  }
}
