import type { Need } from "../../lib/deps.ts";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";

export type WhoamiDeps = Need<{
  credentialStore: "getToken";
  tokenExchange: "fetchUserInfo";
  spinner: "withSpinner";
  log: "data";
}>;

export async function whoami(deps: WhoamiDeps): Promise<void> {
  const token = await deps.credentialStore.getToken();
  if (!token) {
    throw new CliError("Not logged in. Run `clerk auth login` to authenticate", {
      code: ERROR_CODE.AUTH_REQUIRED,
    });
  }

  try {
    const userInfo = await deps.spinner.withSpinner("Fetching account info...", () =>
      deps.tokenExchange.fetchUserInfo(token),
    );
    deps.log.data(userInfo.email);
  } catch {
    throw new CliError("Session expired. Run `clerk auth login` to re-authenticate", {
      code: ERROR_CODE.AUTH_REQUIRED,
    });
  }
}
