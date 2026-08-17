import { revokeAndDeleteToken } from "../../lib/credential-store.ts";
import { clearAuth } from "../../lib/config.ts";
import { log } from "../../lib/log.ts";
import { intro, outro, withSpinner } from "../../lib/spinner.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";

export async function logout(): Promise<void> {
  intro("Signing out");
  await withSpinner("Revoking session...", () => revokeAndDeleteToken());
  await clearAuth();
  log.success("Logged out successfully");
  outro(NEXT_STEPS.LOGOUT);
}
