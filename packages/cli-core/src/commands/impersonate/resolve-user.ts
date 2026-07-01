import { bapiRequest } from "../../lib/bapi.ts";
import { throwUsageError } from "../../lib/errors.ts";
import { isAgent } from "../../mode.ts";
import { pickUser } from "../users/interactive/pick-user.ts";

const USER_ID_PATTERN = /^user_[A-Za-z0-9]+$/;
const CANDIDATE_LIMIT = 5;

type ImpersonationUserCandidate = {
  id: string;
};

/**
 * Resolve the `[user]` positional argument (or its absence) to a single
 * `user_...` ID:
 *
 * - `user_...` → used directly, no lookup.
 * - contains `@` → exact match via `email_address` filter.
 * - otherwise → fuzzy match via `query`.
 * - 0 matches → usage error. 1 match → used directly.
 * - 2+ matches: human mode opens the picker (no prefilled query support —
 *   see pick-user.ts); agent mode errors with candidate IDs.
 * - no argument: human mode opens the picker; agent mode errors (agent mode
 *   never prompts).
 */
export async function resolveImpersonationTarget(
  user: string | undefined,
  secretKey: string,
): Promise<string> {
  if (user === undefined) {
    if (isAgent()) {
      throwUsageError("A user is required in agent mode. Pass it as a positional argument.");
    }
    return pickUser({ secretKey, message: "Pick a user to impersonate:" });
  }

  if (USER_ID_PATTERN.test(user)) {
    return user;
  }

  const searchParams = new URLSearchParams();
  if (user.includes("@")) {
    searchParams.set("email_address", user);
  } else {
    searchParams.set("query", user);
  }
  searchParams.set("limit", String(CANDIDATE_LIMIT + 1));

  const response = await bapiRequest({
    method: "GET",
    path: `/users?${searchParams}`,
    secretKey,
  });

  const users = Array.isArray(response.body) ? (response.body as ImpersonationUserCandidate[]) : [];

  if (users.length === 0) {
    throwUsageError(`No user found matching "${user}".`);
  }

  if (users.length === 1) {
    return users[0]!.id;
  }

  if (isAgent()) {
    const candidates = users
      .slice(0, CANDIDATE_LIMIT)
      .map((candidate) => candidate.id)
      .join(", ");
    throwUsageError(
      `Multiple users match "${user}": ${candidates}. Pass a specific user_id instead.`,
    );
  }

  // pickUser has no prefilled/initial-query support (see pick-user.ts), so
  // the picker re-opens with an empty search box rather than the original
  // term.
  return pickUser({ secretKey, message: `Multiple users match "${user}" — pick one:` });
}
