import { CliError } from "../../lib/errors.ts";

export type RevokeOptions = {
  actorTokenId: string;
  secretKey?: string;
  app?: string;
  instance?: string;
};

// Task 5 replaces this function body with the full revoke flow: login gate,
// targeting, and POST /actor_tokens/{id}/revoke.
export async function revoke(_options: RevokeOptions): Promise<void> {
  throw new CliError("`clerk impersonate revoke` is not implemented yet.");
}
