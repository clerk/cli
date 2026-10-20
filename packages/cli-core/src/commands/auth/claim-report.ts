/**
 * What a claim of the app `clerk init` created did, in words: shared by
 * `clerk auth login` and `clerk link`, which both claim and must say the same
 * thing about the app and the folder.
 */

import type { UserInfo } from "../../lib/token-exchange.ts";
import type { AutoclaimResult, FolderUnchanged } from "../../lib/autoclaim.ts";
import { describeClaimDestination } from "../../lib/claim-prompt.ts";
import { buildDashboardUrl } from "../../lib/environment.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";
import { log } from "../../lib/log.ts";

const CLAIM_WARNINGS: Partial<Record<AutoclaimResult["status"], string>> = {
  not_found:
    "Claim token is no longer valid - the application may have been claimed from the dashboard.",
  no_organization: "Unable to claim - your account does not have an active organization.",
  failed:
    "Auto-claim failed due to a temporary error. It will be retried on your next `clerk auth login`.",
};

export function claimWarning(result: AutoclaimResult): string | undefined {
  if (result.status === "managed_workspace") {
    // The API message already names the provider and says what to do.
    return `Unable to claim - ${result.longMessage ?? "this workspace is managed by an integration provider."}`;
  }
  return CLAIM_WARNINGS[result.status];
}

export type ClaimedResult = Extract<AutoclaimResult, { status: "claimed" }>;

export function reportClaimed({ app, local }: ClaimedResult): void {
  const label = app.name || app.application_id;
  log.success(
    local.kind === "linked"
      ? `Claimed and linked application: \`${label}\``
      : `Claimed application: \`${label}\``,
  );
  // First time this app has a home in an account; say where it is.
  // Deserialized API JSON; a missing array must not fail a claim that
  // already succeeded server-side.
  const development = app.instances?.find(
    (instance) => instance.environment_type === "development",
  );
  if (development) {
    // URL on its own line: with it, the sentence is wider than the frame.
    log.info("Your app now lives in your Clerk account:");
    log.info(`  ${buildDashboardUrl(app.application_id, development.instance_id)}`);
  }
  // After the claim line, so the output says what was claimed before what
  // happened to the folder.
  if (local.kind === "link_failed") {
    log.warn(`Linking this folder failed: ${local.reason}. Run \`clerk link\` to finish setup.`);
  }
  if (local.kind === "unchanged") {
    log.warn(folderLeftAloneWarning(local, { id: app.application_id, label }));
  }
}

/**
 * Names the next command in the warning itself, not only in the outro's next
 * steps: agents see warnings but never the outro. So the commands here must
 * work without a prompt. Plain `clerk link` is suggested only when it can try
 * to match the folder's key by itself (`linkCanTryKey`); otherwise the warning
 * names `clerk link --app`, and the person's next steps add the picker.
 *
 * Each sentence says only what the comparison established: that a key isn't
 * the claimed app's, never which app it does belong to, and never that
 * `clerk link` or `clerk apps list` will identify that app.
 */
function folderLeftAloneWarning(
  local: FolderUnchanged,
  claimed: { id: string; label: string },
): string {
  const leftAlone = "so this folder's link and keys were left alone.";
  const chooseById =
    "Choose the application this folder should use: `clerk apps list --json` lists your applications' IDs, then run `clerk link --app <app_id>`";
  switch (local.reason) {
    case "linked_elsewhere": {
      const linkedLabel = local.linkedTo.appName
        ? `${local.linkedTo.appName} (${local.linkedTo.appId})`
        : local.linkedTo.appId;
      return (
        `This folder stays linked to \`${linkedLabel}\`, so its link and keys were left alone. ` +
        `Run \`clerk link --app ${claimed.id}\` to switch it to \`${claimed.label}\`.`
      );
    }
    case "different_keys": {
      const where = describeKeyLocation(local);
      if (local.mixed) {
        return (
          `This folder holds keys for \`${claimed.label}\` and ${where}, which isn't \`${claimed.label}\`'s, so its link and keys were left alone. ` +
          `Make the folder's Clerk keys belong to one application, then link it. ${chooseById}.`
        );
      }
      const lead = `${capitalize(where)} isn't \`${claimed.label}\`'s, ${leftAlone}`;
      if (local.linkCanTryKey) {
        return `${lead} Run \`clerk link\`; it tries to match that key to an application in your account.`;
      }
      return `${lead} ${chooseById}.`;
    }
    case "unverified":
      return (
        `Couldn't confirm this folder's Clerk keys belong to \`${claimed.label}\`, ${leftAlone} ` +
        `${chooseById}, or run \`clerk link --app ${claimed.id}\` to use \`${claimed.label}\`.`
      );
  }
}

/** "`CLERK_SECRET_KEY` in .env.local", or "the `CLERK_SECRET_KEY` env var". */
function describeKeyLocation({ name, source }: { name: string; source: string }): string {
  return source === `${name} env var` ? `the \`${name}\` env var` : `\`${name}\` in ${source}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function claimedNextSteps({ app, local }: ClaimedResult): readonly string[] {
  switch (local.kind) {
    case "linked":
      return local.envPulled ? NEXT_STEPS.AUTOCLAIMED : NEXT_STEPS.AUTOCLAIMED_NO_ENV;
    case "link_failed":
      return NEXT_STEPS.AUTOCLAIM_MANUAL_LINK;
    case "unchanged":
      switch (local.reason) {
        case "linked_elsewhere":
          return NEXT_STEPS.AUTOCLAIM_LINKED_ELSEWHERE(app.application_id);
        case "different_keys":
          if (local.mixed) return NEXT_STEPS.AUTOCLAIM_MIXED_KEYS;
          return local.linkCanTryKey
            ? NEXT_STEPS.AUTOCLAIM_UNMATCHED_PUBLISHABLE_KEY
            : NEXT_STEPS.AUTOCLAIM_CHOOSE_APP;
        case "unverified":
          return NEXT_STEPS.AUTOCLAIM_UNVERIFIED(app.application_id);
      }
  }
}

/**
 * Login exits 0 after a declined claim, so this says plainly that the app
 * wasn't claimed. With the API key set, it also says how to claim into the
 * signed-in account instead.
 */
export function reportClaimSkipped(appName: string, account: UserInfo): void {
  log.warn(
    `Skipped the claim, so \`${appName}\` is still unclaimed. Its claim token stays in this folder.`,
  );
  if (process.env.CLERK_PLATFORM_API_KEY) {
    const own = describeClaimDestination({ kind: "account", email: account.email || undefined });
    log.info(
      "Claims go to the workspace your `CLERK_PLATFORM_API_KEY` belongs to while it's set. " +
        `Unset it to claim \`${appName}\` into ${own} instead.`,
    );
  }
}
