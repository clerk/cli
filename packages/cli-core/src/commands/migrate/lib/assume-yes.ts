/**
 * Whether this run was given `-y`.
 *
 * `-y` is not the same question as {@link isAgent}. Agent mode says the CLI
 * *cannot* prompt; `-y` says the operator does not want it to. Most prompts
 * only care about the first — a confirm is skipped by either — but the two
 * places that take a default instead of asking need to know a human chose it,
 * so the two cannot be collapsed into one flag.
 *
 * Held per-run rather than threaded through, because the readers are three
 * layers below the command that parses it: `ensureLogDir` runs inside the
 * gutter of seven different commands, and `withInputRetry` sits under every
 * credential prompt. Passing it down would put a `yes` parameter on every
 * export handler signature on the way. This mirrors `mode.ts`, which resolves
 * `--mode` once in a `preAction` hook and is read the same way.
 *
 * Set by the `migrate` group's `preAction` hook, so every subcommand under it
 * is covered whether or not it declares the flag — one that does not simply
 * resolves to `false`.
 */

let assumeYes = false;

/** Records this run's `-y`. Called once per invocation, before the action. */
export function setAssumeYes(value: boolean): void {
  assumeYes = value;
}

/** Whether `-y` was passed to the command now running. */
export function isAssumeYes(): boolean {
  return assumeYes;
}
