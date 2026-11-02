import { join } from "node:path";
import { peekKeylessBreadcrumb, SDK_KEYLESS_FILE } from "./keyless.ts";

/**
 * Who created the application an unlinked folder runs on, when no account owns it yet:
 *
 *  - `init_app`: a signed-out `clerk init` left its claim token in `.clerk/keyless.json`.
 *    `clerk link` can claim it.
 *  - `sdk_app`: a Clerk SDK in keyless mode wrote `.clerk/.tmp/keyless.json`. Only the
 *    Dashboard claim page (`clerk open`) can claim it.
 *  - `plain`: neither file, so the folder is just unlinked.
 */
export type UnlinkedFolder = "init_app" | "sdk_app" | "plain";

export async function classifyUnlinkedFolder(cwd: string): Promise<UnlinkedFolder> {
  // Peek, not read: `readKeylessBreadcrumb` deletes a malformed file, and an error
  // message must not change the folder it describes.
  const breadcrumb = await peekKeylessBreadcrumb(cwd);
  if (breadcrumb?.claimToken) return "init_app";
  if (await Bun.file(join(cwd, ...SDK_KEYLESS_FILE)).exists()) return "sdk_app";
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
        "This folder runs on an application `clerk init` created that no account owns yet. " +
        `Run \`clerk link\` to claim it into your account and link this folder, then rerun \`${rerun}\`.`
      );
    case "sdk_app":
      return (
        "This folder runs on an application a Clerk SDK created that no account owns yet. " +
        "`clerk link` can't list it until it's claimed: a person must run `clerk open` to claim it in the Dashboard. " +
        `Then run \`clerk link\`, choose it, and rerun \`${rerun}\`.`
      );
    case "plain":
      return `No Clerk project linked to this directory. Run \`clerk link\`, then rerun \`${rerun}\`.`;
  }
}
