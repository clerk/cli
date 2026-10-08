/**
 * Whether this run was given `-y`.
 *
 * Not the same question as {@link isAgent}: agent mode says the CLI *cannot*
 * prompt; `-y` says the operator does not want it to.
 *
 * Set once by the `migrate` group's `preAction` hook, so every subcommand under
 * it is covered whether or not it declares the flag — one that does not simply
 * resolves to `false`. Held per run, the way `mode.ts` holds `--mode`, so code
 * below a command's options can read it without the flag being passed down.
 * Nothing in `import` needs that: it reads `options.yes` directly.
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
