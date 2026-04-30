import { deleteToken } from "../../lib/credential-store.ts";
import { clearAuth } from "../../lib/config.ts";
import { log } from "../../lib/log.ts";
import { NEXT_STEPS, printNextSteps } from "../../lib/next-steps.ts";

export async function logout(): Promise<void> {
  await deleteToken();
  await clearAuth();
  log.success("Logged out successfully");
  printNextSteps(NEXT_STEPS.LOGOUT);
}
