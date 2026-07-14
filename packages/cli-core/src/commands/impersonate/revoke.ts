import { isActorTokenNotRevocableError, revokeActorToken } from "../../lib/actor-tokens.ts";
import { CliError, ERROR_CODE, throwUsageError, withApiContext } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { listUserSessions, revokeSession } from "../../lib/sessions.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { isAgent, isHuman } from "../../mode.ts";
import { resolveUsersInstanceContext } from "../users/interactive/instance-context.ts";
import { buildActorStamp, requireLoginEmail } from "./actor.ts";

export type RevokeOptions = {
  actorTokenId: string;
  user?: string;
  secretKey?: string;
  app?: string;
  instance?: string;
};

export async function revoke(options: RevokeOptions): Promise<void> {
  if (options.user && !options.user.startsWith("user_")) {
    throwUsageError(`--user expects a user ID (user_...), got \`${options.user}\`.`);
  }

  // Login is required for revoke too — the login email gates every BAPI call
  // (same as create) and stamps the actor filter used by the session fallback.
  const loginEmail = await requireLoginEmail();

  const ctx = await resolveUsersInstanceContext({
    secretKey: options.secretKey,
    app: options.app,
    instance: options.instance,
  });

  let body;
  try {
    body = await withApiContext(
      withSpinner(`Revoking actor token ${options.actorTokenId}...`, () =>
        revokeActorToken(ctx.secretKey, options.actorTokenId),
      ),
      `Failed to revoke actor token ${options.actorTokenId}`,
    );
  } catch (error) {
    if (!isActorTokenNotRevocableError(error)) throw error;
    await revokeImpersonationSessions(options, ctx.secretKey, loginEmail);
    return;
  }

  if (isAgent()) {
    log.data(
      JSON.stringify({ id: body.id ?? options.actorTokenId, status: body.status ?? "revoked" }),
    );
    return;
  }

  log.success(`Revoked actor token ${options.actorTokenId}.`);
}

/**
 * Fallback for accepted tokens: the token can't be revoked anymore, but the
 * live impersonation persists as a session stamped with the operator's
 * `cli:<login-email>` actor.
 */
async function revokeImpersonationSessions(
  options: RevokeOptions,
  secretKey: string,
  loginEmail: string,
): Promise<void> {
  if (!options.user) {
    throw new CliError(
      `Actor token ${options.actorTokenId} was already accepted — the sign-in URL was opened, so the token itself can no longer be revoked. The impersonation continues as a session. Re-run with the impersonated user's ID to find and revoke it.`,
      {
        code: ERROR_CODE.ACTOR_TOKEN_ALREADY_ACCEPTED,
        examples: [
          {
            command: `clerk imp revoke ${options.actorTokenId} --user <user_id>`,
            description: "Revoke the impersonation session(s) created from this token",
          },
        ],
      },
    );
  }
  const userId = options.user;

  log.warn("Token already accepted — an active impersonation session exists.");

  const sessions = await withApiContext(
    withSpinner(`Looking up active sessions for ${userId}...`, () =>
      listUserSessions(secretKey, { userId, status: "active" }),
    ),
    `Failed to list sessions for ${userId}`,
  );

  // Prefix match so `cli:<email>+<context>` stamps from `--actor` also match.
  const stamp = buildActorStamp(loginEmail).sub;
  const matches = sessions.filter((session) => {
    const sub = session.actor?.sub;
    return sub === stamp || sub?.startsWith(`${stamp}+`);
  });

  if (matches.length === 0) {
    throw new CliError(
      `No active impersonation session on ${userId} was started by ${stamp}. Nothing to revoke.`,
      { code: ERROR_CODE.IMPERSONATION_SESSION_NOT_FOUND },
    );
  }

  const revokedSessionIds: string[] = [];
  for (const session of matches) {
    if (isHuman()) log.info(`Found session ${session.id} (actor: ${session.actor?.sub})`);
    await withApiContext(
      revokeSession(secretKey, session.id),
      `Failed to revoke session ${session.id}`,
    );
    revokedSessionIds.push(session.id);
    if (isHuman()) log.success(`Revoked session ${session.id} — impersonation ended.`);
  }

  if (isAgent()) {
    log.data(JSON.stringify({ id: options.actorTokenId, status: "accepted", revokedSessionIds }));
  }
}
