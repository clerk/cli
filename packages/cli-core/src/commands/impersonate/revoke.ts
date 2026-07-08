import { revokeActorToken } from "../../lib/actor-tokens.ts";
import { withApiContext } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { isAgent } from "../../mode.ts";
import { resolveUsersInstanceContext } from "../users/interactive/instance-context.ts";
import { requireLoginEmail } from "./actor.ts";

export type RevokeOptions = {
  actorTokenId: string;
  secretKey?: string;
  app?: string;
  instance?: string;
};

export async function revoke(options: RevokeOptions): Promise<void> {
  // Login is required for revoke too — the login email itself isn't used
  // here (revoking doesn't stamp a new actor), but the gate must run before
  // any BAPI call, same as create.
  await requireLoginEmail();

  const ctx = await resolveUsersInstanceContext({
    secretKey: options.secretKey,
    app: options.app,
    instance: options.instance,
  });

  const body = await withApiContext(
    withSpinner(`Revoking actor token ${options.actorTokenId}...`, () =>
      revokeActorToken(ctx.secretKey, options.actorTokenId),
    ),
    `Failed to revoke actor token ${options.actorTokenId}`,
  );

  if (isAgent()) {
    log.data(
      JSON.stringify({ id: body.id ?? options.actorTokenId, status: body.status ?? "revoked" }),
    );
    return;
  }

  log.success(`Revoked actor token ${options.actorTokenId}.`);
}
