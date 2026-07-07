/**
 * Backend API (BAPI) actor-token client.
 *
 * Actor tokens back the `clerk impersonate` flow: creating one returns a
 * sign-in URL that logs the caller in as another user, stamped with the
 * `actor` who initiated it. This module owns the BAPI request/response
 * contract (the snake_case wire shape) so commands work with named types
 * instead of hand-built object literals.
 */

import { bapiRequest } from "./bapi.ts";

/** The initiator stamped onto an actor token, echoed into the session's JWT. */
export type ActorTokenActor = {
  sub: string;
  iss: string;
};

export type CreateActorTokenRequest = {
  userId: string;
  actor: ActorTokenActor;
  expiresInSeconds: number;
};

/** A freshly created actor token: `url` signs the caller in as the target user. */
export type ActorToken = {
  id: string;
  url: string;
};

/** Result of revoking an actor token. Fields are optional — BAPI may echo them. */
export type RevokedActorToken = {
  id?: string;
  status?: string;
};

export async function createActorToken(
  secretKey: string,
  request: CreateActorTokenRequest,
): Promise<ActorToken> {
  const response = await bapiRequest({
    method: "POST",
    path: "/actor_tokens",
    secretKey,
    body: JSON.stringify({
      user_id: request.userId,
      actor: { sub: request.actor.sub, iss: request.actor.iss },
      expires_in_seconds: request.expiresInSeconds,
    }),
  });

  return response.body as ActorToken;
}

export async function revokeActorToken(
  secretKey: string,
  actorTokenId: string,
): Promise<RevokedActorToken> {
  const response = await bapiRequest({
    method: "POST",
    path: `/actor_tokens/${actorTokenId}/revoke`,
    secretKey,
  });

  return response.body as RevokedActorToken;
}
