import { resolveAppContext } from "../../lib/config.ts";
import { updateBranchSettings } from "../../lib/plapi.ts";
import { withApiContext } from "../../lib/errors.ts";
import { withGutter, withSpinner, formatTargetSuffix } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";

/**
 * Options for the app-level branching enable/disable toggles. Branching is an
 * application-wide gate on the development root, so only the app is targeted.
 */
interface BranchesToggleOptions {
  app?: string;
}

/**
 * Enable development branching for the application (ADR-0015). Delegates to the
 * shared Platform enable service, which names the dev root `main`. The `branch` /
 * `switch` commands stay passive; this verb-first command is the only activation
 * path (there is deliberately no `clerk branch enable`).
 */
export async function branchesEnable(options: BranchesToggleOptions): Promise<void> {
  const ctx = await resolveAppContext({ app: options.app });

  await withGutter(`Enabling development branches${formatTargetSuffix(ctx.appLabel)}`, async () => {
    await withSpinner(
      "Enabling development branches...",
      () =>
        withApiContext(
          updateBranchSettings(ctx.appId, true),
          "Failed to enable development branches",
        ),
      "Development branches enabled",
    );
    log.info("Run `clerk branch create --name <name>` to create your first branch.");
  });
}

/**
 * Disable development branching for the application (ADR-0015). The server
 * refuses while live forks exist ("delete your branches first") and leaves the
 * dev root named `main` in place.
 */
export async function branchesDisable(options: BranchesToggleOptions): Promise<void> {
  const ctx = await resolveAppContext({ app: options.app });

  await withGutter(
    `Disabling development branches${formatTargetSuffix(ctx.appLabel)}`,
    async () => {
      await withSpinner(
        "Disabling development branches...",
        () =>
          withApiContext(
            updateBranchSettings(ctx.appId, false),
            "Failed to disable development branches",
          ),
        "Development branches disabled",
      );
    },
  );
}
