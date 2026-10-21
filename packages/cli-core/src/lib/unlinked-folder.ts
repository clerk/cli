/**
 * What a folder with no linked application holds, and what to run next.
 *
 * Every message that says a folder isn't linked takes its advice from here,
 * so the same folder gets the same advice from every command. Classifying
 * reads local files and checks whether credentials exist, and makes no API
 * call, so it's safe on any error path.
 *
 * `lib/config.ts` must load this module lazily, on its not-linked path only:
 * the token and credential readers below import `lib/fetch.ts`, which imports
 * `lib/config.ts`. Nothing here uses an import at module load.
 */

import { hasAccountCredentials } from "./credential-store.ts";
import type { Example } from "./help.ts";
import { peekKeylessBreadcrumb } from "./keyless.ts";
import {
  couldntTellReason,
  describeKeyLocation,
  isSdkOnly,
  readFolderKeys,
  SDK_KEYLESS_SOURCE,
  sdkFileWithoutKeyReason,
  unreadableFolderReason,
  type FolderKeys,
  type LocatedKey,
} from "./local-keys.ts";
import { log } from "./log.ts";
import { capitalize } from "./text.ts";

/** Where a key sits, for display. Never its value. */
export interface KeyLocation {
  name: string;
  source: string;
}

/**
 * An unlinked folder, by what it holds. Precedence: an init token, then plain
 * keys, then the SDK keyless file, then nothing.
 *
 * - `init_app`: `.clerk/keyless.json` holds the token `clerk init` saved for
 *   the app it created. The strongest signal, whatever else the folder holds:
 *   the claim check leaves keys of another app alone, so claiming is safe.
 * - `unknown_owner`: plain keys, or Clerk lines the CLI can't settle. Nothing
 *   local says whose app that is (this account's, another's, or unclaimed
 *   with its token lost), so its advice never calls it unclaimed.
 *   `couldntTell` says why `clerk link` can't match by key here: then a person
 *   gets the picker and an agent the usage error.
 * - `sdk_app`: the folder's only keys are the ones a Clerk SDK wrote for an
 *   app it created itself, by `clerk link`'s own test (`isSdkOnly`).
 *   `unusable` says why the file gives no publishable key, when it doesn't:
 *   then `clerk link` stops before any sign-in, saying to link by ID.
 * - `no_app`: none of these.
 */
export type UnlinkedFolder =
  | { kind: "init_app"; signedIn: boolean }
  | {
      kind: "unknown_owner";
      signedIn: boolean;
      publishableKey?: KeyLocation;
      secretKey?: KeyLocation;
      couldntTell?: string;
    }
  | { kind: "sdk_app"; signedIn: boolean; unusable?: string }
  | { kind: "no_app"; signedIn: boolean };

/** What the classifier decides from, so a caller holding its own reads (`doctor`) can pass them. */
export interface UnlinkedFolderFacts {
  /** The folder has an init token. */
  initToken: boolean;
  /** Credentials exist: a stored session or `CLERK_PLATFORM_API_KEY`. Presence only. */
  signedIn: boolean;
  /** The keys the app loads (`readFolderKeys`), or why they couldn't be read, as a clause. */
  keys: FolderKeys | { readError: string };
}

/** Decides the kind from facts. Pure. */
export function classifyUnlinkedFolder({
  initToken,
  signedIn,
  keys,
}: UnlinkedFolderFacts): UnlinkedFolder {
  if (initToken) return { kind: "init_app", signedIn };
  // Unread files may hold any key, so it's never "no app".
  if ("readError" in keys) return { kind: "unknown_owner", signedIn, couldntTell: keys.readError };
  if (isSdkOnly(keys)) {
    return keys.publishableKey
      ? { kind: "sdk_app", signedIn }
      : { kind: "sdk_app", signedIn, unusable: sdkFileWithoutKeyReason(keys.sdkFile) };
  }
  const couldntTell = couldntTellReason(keys);
  if (keys.publishableKey || keys.secretKey || couldntTell || keys.undecided) {
    return {
      kind: "unknown_owner",
      signedIn,
      ...(keys.publishableKey && { publishableKey: locationOf(keys.publishableKey) }),
      ...(keys.secretKey && { secretKey: locationOf(keys.secretKey) }),
      ...(couldntTell && { couldntTell }),
    };
  }
  return { kind: "no_app", signedIn };
}

function locationOf({ name, source }: LocatedKey): KeyLocation {
  return { name, source };
}

/**
 * Reads and classifies the folder at `cwd`, and only `cwd`: from a monorepo
 * package below the folder with the keys, it's `no_app`. Never throws, and
 * changes nothing: a malformed token file is left in place, and a credential
 * read failure (a sandboxed keychain, say) counts as signed out, which only
 * adds a sign-in step to the advice.
 */
export async function readUnlinkedFolder(cwd: string): Promise<UnlinkedFolder> {
  const [token, keys, signedIn] = await Promise.all([
    peekKeylessBreadcrumb(cwd),
    readFolderKeys(cwd).catch((error: unknown) => ({ readError: unreadableFolderReason(error) })),
    hasAccountCredentials().catch(() => false),
  ]);
  const folder = classifyUnlinkedFolder({ initToken: Boolean(token), signedIn, keys });
  log.debug(`unlinked-folder: ${folder.kind}, signed ${signedIn ? "in" : "out"}`);
  return folder;
}

/** The command that stopped, to run again once the folder is linked. */
export interface Rerun {
  /** In the form `clerk link`'s `rerun` option takes: "run `clerk deploy` again". */
  clause: string;
  /** The command itself, for `examples`. Absent when it can't be echoed: its arguments may hold a secret. */
  command?: string;
}

/**
 * What agent-mode `clerk link` (or `clerk init` through it) knew when it
 * stopped without linking. Its stop already says why, so the advice adds
 * only what to run, and never sends the agent back into the same stop.
 * `sessionRefused`: Clerk refused the stored session, so it's as good as none.
 */
export type LinkStop =
  | { autolink: "no_key" }
  | { autolink: "no_match" }
  | { autolink: "couldnt_tell" }
  | { autolink: "list_failed"; sessionRefused: boolean };

export interface NextStep {
  text: string;
  /** The commands `text` names, in order. Sites attach them to the error in agent mode only. */
  examples: Example[];
}

export interface NextStepContext {
  agent: boolean;
  /**
   * Appended as "Then <clause>." For `clerk link`'s own stop, only a retry
   * needs it: once `clerk link --app` has linked the folder, rerunning
   * `clerk link` does nothing.
   */
  rerun?: Rerun;
  /** Set only by agent-mode `clerk link`'s stop. */
  linkStop?: LinkStop;
}

const SIGN_IN = "`clerk auth login` (it opens a browser, so a person must finish signing in)";

const EXAMPLE = {
  signIn: {
    command: "clerk auth login",
    description: "Sign in; a person finishes it in the browser",
  },
  appsList: {
    command: "clerk apps list --json",
    description: "List your applications, to find the ID of the one this folder uses",
  },
  linkById: {
    command: "clerk link --app <app_id>",
    description: "Link this folder to that application",
  },
  open: {
    command: "clerk open",
    description: "Print the claim link, for a person to claim the app in the Clerk Dashboard",
  },
  init: { command: "clerk init", description: "Create a new application for this folder" },
} satisfies Record<string, Example>;

/** The step for `folder`: the text to put after a site's own lead sentence, and its commands. */
export function unlinkedFolderNextStep(folder: UnlinkedFolder, context: NextStepContext): NextStep {
  const { agent, rerun, linkStop } = context;
  if (agent && linkStop && folder.kind !== "init_app") {
    if (linkStop.autolink === "list_failed" && folder.signedIn && !linkStop.sessionRefused) {
      return retry(rerun);
    }
    return withRerun(afterLinkStop(folder, linkStop), rerun);
  }
  return withRerun(stepFor(folder, agent, folder.signedIn), rerun);
}

function stepFor(folder: UnlinkedFolder, agent: boolean, signedIn: boolean): NextStep {
  switch (folder.kind) {
    case "init_app":
      return initApp(agent, signedIn);
    case "sdk_app":
      return folder.unusable
        ? unusableSdkApp(folder.unusable, agent, signedIn)
        : sdkApp(agent, signedIn);
    case "unknown_owner":
      return unknownOwner(folder, agent, signedIn);
    case "no_app":
      return noApp(agent, signedIn);
  }
}

/**
 * After agent-mode `clerk link` stopped. A failed list that wasn't about
 * sign-in is a retry, handled by the caller.
 */
function afterLinkStop(folder: UnlinkedFolder, stop: LinkStop): NextStep {
  switch (stop.autolink) {
    case "no_match": {
      const key =
        folder.kind === "unknown_owner" && folder.publishableKey
          ? `the publishable key in ${folder.publishableKey.source}`
          : "this folder's publishable key";
      return chooseById(`No application in your account uses ${key}.`, true);
    }
    case "couldnt_tell":
      // The stop's reason already says why.
      return chooseById(undefined, folder.signedIn);
    case "list_failed":
      // Clerk refused the session: as good as signed out.
      return stepFor(folder, true, false);
    case "no_key":
      if (folder.kind === "no_app" && folder.signedIn) {
        // Today's wording at this stop, kept.
        return {
          text: "Pass --app <id>, or run `clerk apps list --json` and retry.",
          examples: [EXAMPLE.appsList, EXAMPLE.linkById],
        };
      }
      if (folder.kind === "unknown_owner" && folder.publishableKey && folder.signedIn) {
        // `clerk link` would just stop again.
        return chooseById(undefined, true);
      }
      return stepFor(folder, true, folder.signedIn);
  }
}

function initApp(agent: boolean, signedIn: boolean): NextStep {
  const lead = "This folder's app was created by `clerk init` and isn't in an account yet.";
  // `clerk link` claims it: a person's signs in first, and an agent's claims
  // with whatever credential it has, `CLERK_PLATFORM_API_KEY` included. Only
  // an agent with none needs `clerk auth login`, which claims on its own.
  if (agent && !signedIn) {
    return {
      text: `${lead} Run ${SIGN_IN}: it claims the app and links this folder.`,
      examples: [
        {
          command: "clerk auth login",
          description: "Sign in, then claim this folder's app and link it",
        },
      ],
    };
  }
  return {
    text: `${lead} Run \`clerk link\`: it claims the app into your account and links this folder.`,
    examples: [{ command: "clerk link", description: "Claim this folder's app and link it" }],
  };
}

function sdkApp(agent: boolean, signedIn: boolean): NextStep {
  const lead = "This folder runs on an app the Clerk SDK created during development.";
  if (!agent) {
    return {
      text: `${lead} Run \`clerk link\`: it links the app if it's in your account, or opens the Clerk Dashboard page to claim it. After claiming it, run \`clerk link\` again.`,
      examples: [
        { command: "clerk link", description: "Link the app, or open the page to claim it" },
      ],
    };
  }
  // An agent can't claim it; a person does, from the link `clerk open` prints.
  const linkClaimed = { command: "clerk link", description: "Link the app once it's claimed" };
  const open = "Run `clerk open` to print its claim link for a person to claim the app";
  return signedIn
    ? {
        text: `${lead} ${open}, then \`clerk link\` once it's claimed.`,
        examples: [EXAMPLE.open, linkClaimed],
      }
    : {
        text: `${lead} ${open}, then ${SIGN_IN}, then \`clerk link\` once it's claimed.`,
        examples: [EXAMPLE.open, EXAMPLE.signIn, linkClaimed],
      };
}

function unusableSdkApp(why: string, agent: boolean, signedIn: boolean): NextStep {
  // `clerk link`'s own stop for this file, before any sign-in or app list.
  const lead = `This folder's Clerk SDK keyless file (\`${SDK_KEYLESS_SOURCE}\`) has no usable claim link: ${why}.`;
  if (!agent) {
    return {
      text: `${lead} Link an existing application with \`clerk link --app <app_id>\`.`,
      examples: [EXAMPLE.linkById],
    };
  }
  return chooseById(lead, signedIn);
}

function unknownOwner(
  folder: Extract<UnlinkedFolder, { kind: "unknown_owner" }>,
  agent: boolean,
  signedIn: boolean,
): NextStep {
  // `clerk link` can't match by key here: a person gets the picker, an agent
  // the usage error. So choose by ID, never a promise of detection.
  if (folder.couldntTell) {
    const lead = `${capitalize(folder.couldntTell)}.`;
    return agent ? chooseById(lead, signedIn) : pickInLink(lead);
  }
  if (folder.publishableKey) {
    const lead = `This folder's Clerk publishable key is ${describeKeyLocation(folder.publishableKey)}.`;
    const find =
      "`clerk link`: it finds the app in your account by that key. If none uses it, link one with `clerk link --app <app_id>`";
    const linkByKey = {
      command: "clerk link",
      description: "Find the app by this folder's publishable key and link it",
    };
    return agent && !signedIn
      ? { text: `${lead} Run ${SIGN_IN}, then ${find}.`, examples: [EXAMPLE.signIn, linkByKey] }
      : { text: `${lead} Run ${find}.`, examples: [linkByKey] };
  }
  // `clerk link` matches only publishable keys.
  const lead = folder.secretKey
    ? `This folder's Clerk secret key is ${describeKeyLocation(folder.secretKey)}, but it has no publishable key, so \`clerk link\` can't match it to an application.`
    : "This folder has Clerk secret keys but no publishable key, so `clerk link` can't match them to an application.";
  return agent ? chooseById(lead, signedIn) : pickInLink(lead);
}

function noApp(agent: boolean, signedIn: boolean): NextStep {
  if (!agent) {
    return {
      text: "Run `clerk link` to choose one of your apps, or `clerk init` to create one.",
      examples: [
        { command: "clerk link", description: "Choose one of your applications" },
        EXAMPLE.init,
      ],
    };
  }
  const choose =
    "`clerk apps list --json`, then `clerk link --app <app_id>`; or `clerk init` to create an app";
  return signedIn
    ? { text: `Run ${choose}.`, examples: [EXAMPLE.appsList, EXAMPLE.linkById, EXAMPLE.init] }
    : {
        text: `Run ${SIGN_IN} first, then ${choose}.`,
        examples: [EXAMPLE.signIn, EXAMPLE.appsList, EXAMPLE.linkById, EXAMPLE.init],
      };
}

/** A person's `clerk link` shows the picker here, after saying why it can't match. */
function pickInLink(lead: string): NextStep {
  return {
    text: `${lead} Run \`clerk link\` and choose the app this folder uses.`,
    examples: [{ command: "clerk link", description: "Choose the application this folder uses" }],
  };
}

/** For an agent, which can't use the picker: list the apps, then link one by ID. */
function chooseById(lead: string | undefined, signedIn: boolean): NextStep {
  const choose =
    "`clerk apps list --json`, then `clerk link --app <app_id>` with the app this folder uses";
  const action = signedIn ? `Run ${choose}.` : `Run ${SIGN_IN}, then ${choose}.`;
  return {
    text: lead ? `${lead} ${action}` : action,
    examples: signedIn
      ? [EXAMPLE.appsList, EXAMPLE.linkById]
      : [EXAMPLE.signIn, EXAMPLE.appsList, EXAMPLE.linkById],
  };
}

/**
 * A list that failed for a reason other than sign-in can be temporary: the
 * one time the advice is the command that stopped, as a retry.
 */
function retry(rerun: Rerun | undefined): NextStep {
  return {
    text: `A failed list can be temporary, so retry: ${rerun?.clause ?? "run the same command again"}.`,
    examples: rerun?.command ? [{ command: rerun.command, description: "Retry" }] : [],
  };
}

function withRerun(step: NextStep, rerun: Rerun | undefined): NextStep {
  if (!rerun) return step;
  return {
    text: `${step.text} Then ${rerun.clause}.`,
    examples: rerun.command
      ? [
          ...step.examples,
          { command: rerun.command, description: "Run it again once this folder is linked" },
        ]
      : step.examples,
  };
}
