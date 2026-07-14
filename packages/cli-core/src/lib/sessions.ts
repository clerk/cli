/**
 * Backend API (BAPI) sessions client.
 *
 * Sessions created from an actor token carry the initiating actor in
 * `session.actor` (the CLI stamps `cli:<login-email>`), which is how
 * `clerk impersonate revoke` finds and ends a live impersonation once the
 * actor token itself was accepted and can no longer be revoked.
 */

import { bapiRequest } from "./bapi.ts";

/** The actor claim stamped onto sessions created from an actor token. */
export type SessionActor = {
  sub?: string;
  iss?: string;
};

/** The subset of BAPI's Session object the CLI consumes. */
export type Session = {
  id: string;
  status?: string;
  actor?: SessionActor | null;
};

/** Result of revoking a session. Fields are optional — BAPI may echo them. */
export type RevokedSession = {
  id?: string;
  status?: string;
};

export async function listUserSessions(
  secretKey: string,
  query: { userId: string; status?: string },
): Promise<Session[]> {
  const params = new URLSearchParams({ user_id: query.userId });
  if (query.status) {
    params.set("status", query.status);
  }

  const response = await bapiRequest({
    method: "GET",
    path: `/sessions?${params}`,
    secretKey,
  });

  // BAPI list endpoints exist in two shapes: a plain array and a paginated
  // `{ data: [...] }` envelope. Accept both.
  const body = response.body;
  if (Array.isArray(body)) {
    return body as Session[];
  }
  const data = (body as { data?: Session[] } | null)?.data;
  return Array.isArray(data) ? data : [];
}

export async function revokeSession(secretKey: string, sessionId: string): Promise<RevokedSession> {
  const response = await bapiRequest({
    method: "POST",
    path: `/sessions/${sessionId}/revoke`,
    secretKey,
  });

  return response.body as RevokedSession;
}
