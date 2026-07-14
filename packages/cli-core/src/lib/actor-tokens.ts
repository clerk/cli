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
import { BapiError } from "./errors.ts";

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

/**
 * BAPI's `POST /actor_tokens/{id}/revoke` only revokes **pending** tokens and
 * answers 400 once the sign-in ticket was consumed (token `accepted`). At that
 * point the impersonation lives on as a session — only a sessions-API revoke
 * can end it.
 */
export function isActorTokenNotRevocableError(error: unknown): boolean {
  return error instanceof BapiError && error.status === 400;
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
