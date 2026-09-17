/**
 * Retrying the *answer*, not the request.
 *
 * Distinct from `retry.ts`, which re-sends an identical request after a 429:
 * there the request was right and the server was busy. Here the request was
 * fine and the input was wrong, so nothing changes until the operator supplies
 * something better.
 *
 * Every credential a migration takes — a connection string, a Firebase service
 * account key, an Auth0 client secret — is long, pasted by hand, masked as it
 * is typed, and wrong in ways nothing local can check: a typo'd host, an
 * expired token, a key that was revoked, the right server but the wrong
 * database. Only the remote end can say, and by then the operator has already
 * answered every other question the command asked. Ending there charges them a
 * full re-run for one line they could not see.
 */

import { CliError } from "../../../lib/errors.ts";
import { log } from "../../../lib/log.ts";
import { isAgent, isHuman } from "../../../mode.ts";
import { isAssumeYes } from "./assume-yes.ts";

/**
 * Runs `work`, and on failure asks for the input again and runs it once more.
 *
 * Keep `work` to the step that *proves* the input — the connection, the token
 * exchange. Everything inside runs again on each attempt, so work that has
 * already written a file, or a long fetch the credential has already been
 * accepted for, does not belong in here.
 *
 * `-y`, agent mode and a non-TTY get the failure unchanged: there is nobody to
 * ask, and a loop that cannot prompt is a loop that cannot end. A cancelled
 * prompt throws {@link UserAbortError}, which is not a `CliError` and so leaves
 * the loop — declining the question is an answer.
 *
 * @param input - What to try first: a flag, an environment value, or the
 *   answer to the prompt the caller has already put up.
 * @param reprompt - Asks for a replacement. Called once per failure.
 * @param work - The step the input has to survive.
 * @returns The result, and the input that produced it — which is not `input`
 *   when it took a retry, and later steps need the one that worked.
 */
export async function withInputRetry<I, T>(
  input: I,
  reprompt: () => Promise<I>,
  work: (input: I) => Promise<T>,
): Promise<{ value: T; input: I }> {
  let candidate = input;

  for (;;) {
    try {
      return { value: await work(candidate), input: candidate };
    } catch (error) {
      // Everything these steps raise for a bad credential is a CliError
      // carrying its own explanation; anything else (an interrupt, a bug) is
      // not ours to retry.
      if (!(error instanceof CliError) || !isHuman() || isAgent() || isAssumeYes()) throw error;

      log.error(error.message);
      candidate = await reprompt();
    }
  }
}
