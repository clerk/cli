import { getToken } from "../lib/credential-store.ts";
import { fetchUserInfo } from "../lib/token-exchange.ts";

export async function whoami() {
  const token = await getToken();
  if (!token) {
    console.log("Not logged in. Run `clerk auth login` to authenticate.");
    return;
  }

  try {
    const userInfo = await fetchUserInfo(token);
    console.log(userInfo.email);
  } catch {
    console.log("Session expired. Run `clerk auth login` to re-authenticate.");
    return;
  }
}
