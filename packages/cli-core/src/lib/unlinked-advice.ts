import { peekKeylessBreadcrumb, readSdkClaimUrl } from "./keyless.ts";

/**
 * Who created the application an unlinked folder runs on, when no account owns it yet:
 *
 *  - `init_app`: a signed-out `clerk init` left its claim token in `.clerk/keyless.json`.
 *    `clerk link` claims it if no account owns it yet; a Dashboard claim can leave the file behind.
 *  - `sdk_app`: a Clerk SDK in keyless mode wrote a usable claim link to
 *    `.clerk/.tmp/keyless.json`. Only the Dashboard claim page (`clerk open`) can claim it.
 *  - `plain`: neither, so the folder is just unlinked. An SDK file without a usable link
 *    counts as `plain`, because `clerk open` would have nothing to open.
 */
export type UnlinkedFolder = "init_app" | "sdk_app" | "plain";

export async function classifyUnlinkedFolder(cwd: string): Promise<UnlinkedFolder> {
  // Peek, not read: `readKeylessBreadcrumb` deletes a malformed file, and an error
  // message must not change the folder it describes.
  const breadcrumb = await peekKeylessBreadcrumb(cwd);
  if (breadcrumb?.claimToken) return "init_app";
  if (await readSdkClaimUrl(cwd)) return "sdk_app";
  return "plain";
}

/**
 * The `not_linked` message for a command that needs a linked folder. `rerun` is the
 * command to retry afterwards, e.g. "clerk deploy status".
 */
export async function notLinkedMessage(cwd: string, rerun: string): Promise<string> {
  switch (await classifyUnlinkedFolder(cwd)) {
    case "init_app":
      return (
        "This folder holds a claim token a signed-out `clerk init` wrote to `.clerk/keyless.json`. " +
        "If no account owns that application yet, `clerk link` claims it into your account. " +
        `Run \`clerk link\` to link this folder, then rerun \`${rerun}\`.`
      );
    case "sdk_app":
      return (
        "This folder holds a claim link a Clerk SDK wrote to `.clerk/.tmp/keyless.json`. " +
        "If no account owns that application yet, a person must run `clerk open` to claim it in the Dashboard. " +
        "Then run `clerk link` and choose it (agents: `clerk auth login` if needed, then `clerk apps list --json` and `clerk link --app <app_id>`), " +
        `then rerun \`${rerun}\`.`
      );
    case "plain":
      return `No Clerk project linked to this directory. Run \`clerk link\`, then rerun \`${rerun}\`.`;
  }
}
