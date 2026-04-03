import { deleteToken } from "../../lib/credential-store.ts";
import { clearAuth } from "../../lib/config.ts";
import { log } from "../../lib/log.ts";

export async function logout(): Promise<void> {
  await deleteToken();
  await clearAuth();
  log.data("Logged out successfully");
}
