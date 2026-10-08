/**
 * Whether this run was given `-y`.
 *
 * Not the same question as {@link isAgent}: agent mode says the CLI *cannot*
 * prompt; `-y` says the operator does not want it to. A confirm is skipped by
 * either, but `withInputRetry` needs to know a human chose not to be asked:
 * under `-y` a rejected credential fails instead of being asked for again.
 *
 * Set once by the `migrate` group's `preAction` hook, so every subcommand under
 * it is covered whether or not it declares the flag — one that does not simply
 * resolves to `false`. Held per run, the way `mode.ts` holds `--mode`, because
 * its readers sit layers below the command that parses it: `withInputRetry`
 * runs under every credential prompt, and passing `yes` down would put it on
 * every export handler on the way.
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
