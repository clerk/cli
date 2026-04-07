/**
 * "Link if not already linked" helper.
 *
 * Encapsulates the logic that init runs at the top of its flow:
 * 1. If a profile already exists for the current cwd, print its status and
 *    return without doing more work.
 * 2. If no profile exists and no `--app` was provided, attempt the
 *    publishable-key-based autolink. If autolink succeeds, return.
 * 3. Otherwise, fall through to the same interactive link flow the public
 *    `link` command runs (auth gate, app picker, profile write).
 *
 * Returns whether a profile is now linked and (if so) the appId. The return
 * value is informational; callers may ignore it.
 */

import type { Need } from "../../../lib/deps.ts";
import { autolink } from "../../../lib/autolink.ts";
import { gatherContext, runLinkFlow, printExistingStatus } from "../index.ts";
import type { LinkOptions, LinkDeps } from "../index.ts";

export type LinkIfNeededDeps = Need<{
  configStore: "resolveProfile";
  git: "getGitRepoRoot" | "getGitRepoIdentifier" | "getGitNormalizedRemote";
}> &
  // The fall-through path runs the same interactive link flow as the public
  // command, so the helper inherits the public command's full slice. Init
  // already passes the full Root, which is structurally assignable.
  LinkDeps;

export interface LinkIfNeededResult {
  linked: boolean;
  appId?: string;
}

export async function linkIfNeeded(
  deps: LinkIfNeededDeps,
  options: LinkOptions = {},
): Promise<LinkIfNeededResult> {
  const ctx = await gatherContext(deps);
  const existing = await deps.configStore.resolveProfile(ctx.cwd);

  if (existing) {
    printExistingStatus(deps, existing, ctx.normalizedRemote);
    return { linked: true, appId: existing.profile.appId };
  }

  if (!options.app) {
    const autolinked = await autolink(ctx.cwd);
    if (autolinked) {
      return { linked: true, appId: autolinked.profile.appId };
    }
  }

  const result = await runLinkFlow(deps, options, ctx, true);
  return { linked: true, appId: result.appId };
}
