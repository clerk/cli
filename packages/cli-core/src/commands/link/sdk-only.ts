/**
 * `clerk link` in an SDK-only folder: no init token, no plain key, and the
 * keys of an app a Clerk SDK created for itself in `.clerk/.tmp/keyless.json`
 * (during `next dev`, say).
 *
 * The CLI can't claim that app (there's no claim token), so it looks for the
 * app in the account by the SDK file's publishable key. When the app isn't
 * there, a person is sent to its claim page in the Dashboard and reruns
 * `clerk link` after claiming; an agent is told to run `clerk open`, which
 * prints the claim link for a person. Never the picker or a new app: any app
 * chosen there isn't the one the SDK runs.
 */

import { linkApp, matchKeyToApp } from "../../lib/autolink.ts";
import { claimDestination, describeClaimDestination } from "../../lib/claim-prompt.ts";
import { CliError, ERROR_CODE, errorMessage, throwUsageError } from "../../lib/errors.ts";
import {
  readFolderKeys,
  readSdkClaimLink,
  SDK_KEYLESS_SOURCE,
  type FolderKeys,
} from "../../lib/local-keys.ts";
import { log } from "../../lib/log.ts";
import { openBrowser } from "../../lib/open.ts";
import { listApplications, type Application } from "../../lib/plapi.ts";
import { cyan } from "../../lib/color.ts";
import { signedInAccount } from "./account.ts";

export type SdkOnlyOutcome = { status: "linked"; appId: string } | { status: "claim_page_opened" };

/** The lead sentence of agent-mode `clerk link`'s not-linked stop, kept verbatim. */
const AGENT_LEAD = "Cannot select an application in agent mode.";

/**
 * Links an SDK-only folder to its app, or sends a person to claim it.
 * Undefined when the folder isn't SDK-only, for `link` to carry on.
 *
 * Throws `usage_error` (exit 2) when the SDK file has no usable claim link,
 * in either mode, and for an agent whose account lacks the app or whose app
 * list failed. A person's failed app list throws the original error.
 */
export async function linkSdkOnlyFolder(
  cwd: string,
  agent: boolean,
  /** Opens `clerk link`'s frame, once the folder is known to be SDK-only. */
  openFrame: () => void,
): Promise<SdkOnlyOutcome | undefined> {
  const keys = await readFolderKeys(cwd);
  if (!isSdkOnly(keys)) return undefined;
  openFrame();

  // Before any list or sign-in: without a usable claim link, the CLI can't
  // say how to claim the app, so it never guesses with a picker.
  function noUsableLink(why: string): never {
    throwUsageError(
      `${agent ? `${AGENT_LEAD} ` : ""}This folder's Clerk SDK keyless file (\`${SDK_KEYLESS_SOURCE}\`) has no usable claim link: ${why}. Link an existing application with \`clerk link --app <app_id>\`.`,
    );
  }
  const publishableKey = keys.publishableKey?.value;
  if (!publishableKey) {
    noUsableLink(
      keys.sdkFile?.state === "unreadable" ? "it can't be read" : "it has no publishable key",
    );
  }
  const claimLink = await readSdkClaimLink(cwd);
  if (claimLink.status === "unusable") noUsableLink(claimLink.reason);

  const account = agent ? null : await signedInAccount();
  let apps: Application[];
  try {
    apps = await listApplications();
  } catch (error) {
    if (!agent) throw error;
    throwUsageError(
      `${AGENT_LEAD} This folder's app was created by the Clerk SDK, and the CLI couldn't list your applications to look for it (${errorMessage(error)}). Sign in with \`clerk auth login\`, or retry.`,
    );
  }

  const match = matchKeyToApp([{ key: publishableKey, source: SDK_KEYLESS_SOURCE }], apps);
  if (match) {
    if (!(await linkApp(match.app, cwd))) {
      throw new CliError("Application has no development instance", {
        code: ERROR_CODE.INSTANCE_NOT_FOUND,
      });
    }
    log.success(
      `Linked to ${cyan(match.app.name || match.app.application_id)}, the app the Clerk SDK created for this folder`,
    );
    return { status: "linked", appId: match.app.application_id };
  }

  if (agent) {
    throwUsageError(
      `${AGENT_LEAD} This folder's app was created by the Clerk SDK and isn't in your account yet. Run \`clerk open\` to get its claim link for a person to claim it, then run \`clerk link\` again.`,
    );
  }

  await sendToClaimPage(claimLink.url, account);
  return { status: "claim_page_opened" };
}

/**
 * The SDK writes its keyless file only when nothing else configures Clerk, so
 * the folder is SDK-only when it holds no plain key, no Clerk line the CLI
 * can't read, and no undecided key, and the SDK file exists.
 */
function isSdkOnly(keys: FolderKeys): boolean {
  return Boolean(keys.sdkFile) && keys.sdkFile?.state !== "absent";
}

/**
 * Opens the claim page and says what to do next. The URL is only ever handed
 * to the browser launcher, never printed or logged: it carries a
 * credential-equivalent token. The launcher passes it to its wrapper as a
 * diagnostics target, which reaches a debug line only in agent mode, and
 * agents never get here.
 */
async function sendToClaimPage(url: string, account: { email?: string } | null): Promise<void> {
  const destination = claimDestination(account);
  const into = destination ? describeClaimDestination(destination) : "your account";
  const notInAccount = "This folder's app was created by the Clerk SDK and isn't in an account yet";
  const printIt = "run `clerk open --print` to print the claim link, open it on any device";

  const opened = await openBrowser(url);
  if (!opened.ok) {
    log.warn(
      `Couldn't open a browser here. ${notInAccount}. To claim it, ${printIt}, claim it into ${into}, then run \`clerk link\` again.`,
    );
    return;
  }
  log.info(`${notInAccount}, so \`clerk link\` can't find it.`);
  // A claim into any other account or workspace leaves the rerun with no
  // match, and it would open the claim page again.
  log.info(
    `Opened its claim page in your browser. Claim it into ${into}, the one \`clerk link\` searches, then run \`clerk link\` again.`,
  );
  // Always said: a launcher can succeed while nothing opens on this screen
  // (over SSH to a Mac, `open` opens the remote machine's browser).
  log.info(`If no browser opened on your screen, ${printIt}, then run \`clerk link\` again.`);
}
