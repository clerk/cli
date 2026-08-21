import { revokeAndDeleteToken } from "../../lib/credential-store.ts";
import { clearAuth } from "../../lib/config.ts";
import { log } from "../../lib/log.ts";
import { intro, outro, withSpinner } from "../../lib/spinner.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";

export async function logout(): Promise<void> {
  intro("Signing out");
  const outcome = await withSpinner("Revoking session...", () => revokeAndDeleteToken());
  await clearAuth();

  if (outcome === "failed") {
    // The local credentials are gone either way, but the grant may still be
    // redeemable by anyone holding a copy. Saying "logged out" here would be
    // the false assurance this whole path exists to avoid.
    log.warn(
      "Signed out locally, but the session could not be revoked with Clerk. If the credentials may have been exposed, revoke the session from the dashboard.",
    );
  } else {
    log.success("Logged out successfully");
  }

  if (process.env.CLERK_PLATFORM_API_KEY) {
    log.warn(
      "`CLERK_PLATFORM_API_KEY` is set and still authenticates requests. Unset it to fully sign out.",
    );
  }

  await outro(NEXT_STEPS.LOGOUT);
}
