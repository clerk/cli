import { getValidToken } from "../../lib/credential-store.ts";
import { AuthError } from "../../lib/errors.ts";
import { fetchUserInfo } from "../../lib/token-exchange.ts";

export const CLERK_CLI_ISSUER = "clerk-cli";

/**
 * Verify the CLI has an active login session and return the operator's
 * login email. Impersonation always requires `clerk login` — there is no
 * secret-key bypass, because the actor stamp on every actor token must
 * identify a real Clerk account for audit purposes.
 */
export async function requireLoginEmail(): Promise<string> {
  const token = await getValidToken();
  if (!token) {
    throw new AuthError({ reason: "not_logged_in" });
  }

  try {
    const userInfo = await fetchUserInfo(token);
    return userInfo.email;
  } catch {
    throw new AuthError({ reason: "session_expired" });
  }
}

/**
 * Build the actor stamp embedded in every actor token: `cli:<login-email>`,
 * or `cli:<login-email>+<context>` when `--actor <context>` is supplied.
 * This is a write-only audit label — never parse it back apart.
 */
export function buildActorStamp(
  loginEmail: string,
  actorContext?: string,
): { sub: string; iss: typeof CLERK_CLI_ISSUER } {
  const sub = actorContext ? `cli:${loginEmail}+${actorContext}` : `cli:${loginEmail}`;
  return { sub, iss: CLERK_CLI_ISSUER };
}
