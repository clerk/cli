import { bapiRequest } from "../../lib/bapi.ts";
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

  const response = await withApiContext(
    withSpinner(`Revoking actor token ${options.actorTokenId}...`, () =>
      bapiRequest({
        method: "POST",
        path: `/actor_tokens/${options.actorTokenId}/revoke`,
        secretKey: ctx.secretKey,
      }),
    ),
    `Failed to revoke actor token ${options.actorTokenId}`,
  );

  const body = response.body as { id?: string; status?: string };

  if (isAgent()) {
    log.data(
      JSON.stringify({ id: body.id ?? options.actorTokenId, status: body.status ?? "revoked" }),
    );
    return;
  }

  log.success(`Revoked actor token ${options.actorTokenId}.`);
}
