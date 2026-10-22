/**
 * What a folder with no linked application holds, and what to run next.
 *
 * Every message that says a folder isn't linked takes its advice from here,
 * so the same folder gets the same advice from every command. Classifying
 * reads local files and checks which credential is present, and makes no API
 * call, so it's safe on any error path.
 *
 * `lib/config.ts` must load this module lazily, on its not-linked path only:
 * the token and credential readers below import `lib/fetch.ts`, which imports
 * `lib/config.ts`. Nothing here uses an import at module load.
 */

import type { KeylessSubject } from "./copy.ts";
import { hasStoredCredentials } from "./credential-store.ts";
import { CliError, ERROR_CODE, type CredentialRefusal, type NextStepAdvice } from "./errors.ts";
import type { Example } from "./help.ts";
import { quoteArg } from "./json-body.ts";
import { peekKeylessBreadcrumb } from "./keyless.ts";
import {
  couldntTellReason,
  describeKeyLocation,
  isSdkOnly,
  LINK_EXISTING_APP_SENTENCE,
  noUsableClaimLinkSentence,
  readFolderKeys,
  readSdkClaimLink,
  SDK_KEYLESS_SOURCE,
  sdkFileWithoutKeyReason,
  secretKeysDisagreeReason,
  unreadableFolderReason,
  type FolderKeys,
  type LocatedKey,
} from "./local-keys.ts";
import { log } from "./log.ts";
import { capitalize } from "./text.ts";
import { isAgent } from "../mode.ts";

/**
 * The credential Platform API calls would use. `CLERK_PLATFORM_API_KEY` wins
 * over a stored session (`getAuthToken` in `plapi.ts`), so it's what decides
 * where a claim goes and what a refusal means.
 */
export type Credential = "api_key" | "session" | "none";

/** Where a key sits, for display. Never its value. */
export interface KeyLocation {
  name: string;
  source: string;
}

/**
 * Why an SDK-created app can't be claimed from this folder. `findableByKey`:
 * the file still has a publishable key, so `clerk link` finds the app by it
 * when it's already in the account.
 */
export interface SdkClaimProblem {
  reason: string;
  findableByKey: boolean;
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
 *   gets the picker and an agent the usage error. `secretKeysDisagree` says
 *   why no command runs on the folder's secret key; `clerk link` still
 *   matches by the publishable key.
 * - `sdk_app`: the folder's only keys are the ones a Clerk SDK wrote for an
 *   app it created itself, by `clerk link`'s own test (`isSdkOnly`).
 *   `unusable` says why its file can't send anyone to claim the app: then
 *   `clerk link` stops saying to link by ID, after finding the app by key
 *   when the file has one.
 * - `no_app`: none of these.
 */
export type UnlinkedFolder =
  | { kind: "init_app"; credential: Credential }
  | {
      kind: "unknown_owner";
      credential: Credential;
      publishableKey?: KeyLocation;
      secretKey?: KeyLocation;
      couldntTell?: string;
      secretKeysDisagree?: string;
    }
  | { kind: "sdk_app"; credential: Credential; unusable?: SdkClaimProblem }
  | { kind: "no_app"; credential: Credential };

/** What the classifier decides from, so a caller holding its own reads (`doctor`) can pass them. */
export interface UnlinkedFolderFacts {
  /** The folder has an init token. */
  initToken: boolean;
  /** Presence only: whether a credential works is known only from an API call. */
  credential: Credential;
  /** The keys the app loads (`readFolderKeys`), or why they couldn't be read, as a clause. */
  keys: FolderKeys | { readError: string };
  /**
   * Why the SDK keyless file's claim link can't be used (`readSdkClaimLink`'s
   * reason), for an SDK-only folder with a publishable key; undefined when it
   * can, or doesn't apply. Required, so a caller can't skip the check and
   * leave an unclaimable app looking claimable.
   */
  sdkClaimLinkProblem: string | undefined;
}

/** Decides the kind from facts. Pure. */
export function classifyUnlinkedFolder({
  initToken,
  credential,
  keys,
  sdkClaimLinkProblem,
}: UnlinkedFolderFacts): UnlinkedFolder {
  if (initToken) return { kind: "init_app", credential };
  // Unread files may hold any key, so it's never "no app".
  if ("readError" in keys) {
    return { kind: "unknown_owner", credential, couldntTell: keys.readError };
  }
  if (isSdkOnly(keys)) {
    // The same order as `clerk link`: no publishable key stops it before any
    // lookup; with one, it matches first and needs the claim link only after.
    if (!keys.publishableKey) {
      return {
        kind: "sdk_app",
        credential,
        unusable: { reason: sdkFileWithoutKeyReason(keys.sdkFile), findableByKey: false },
      };
    }
    return sdkClaimLinkProblem
      ? {
          kind: "sdk_app",
          credential,
          unusable: { reason: sdkClaimLinkProblem, findableByKey: true },
        }
      : { kind: "sdk_app", credential };
  }
  const couldntTell = couldntTellReason(keys);
  const secretKeysDisagree = secretKeysDisagreeReason(keys);
  if (keys.publishableKey || keys.secretKey || couldntTell || keys.undecided) {
    return {
      kind: "unknown_owner",
      credential,
      ...(keys.publishableKey && { publishableKey: locationOf(keys.publishableKey) }),
      ...(keys.secretKey && { secretKey: locationOf(keys.secretKey) }),
      ...(couldntTell && { couldntTell }),
      ...(secretKeysDisagree && { secretKeysDisagree }),
    };
  }
  return { kind: "no_app", credential };
}

function locationOf({ name, source }: LocatedKey): KeyLocation {
  return { name, source };
}

/** Whether any credential is present; a refused one still counts until a call says so. */
function isSignedIn(credential: Credential): boolean {
  return credential !== "none";
}

/**
 * Reads and classifies the folder at `cwd`, and only `cwd`: from a monorepo
 * package below the folder with the keys, it's `no_app`. Never throws, and
 * changes nothing: a malformed token file is left in place, and a credential
 * read failure (a sandboxed keychain, say) counts as no credential, which only
 * adds a sign-in step to the advice.
 */
export async function readUnlinkedFolder(cwd: string): Promise<UnlinkedFolder> {
  const [token, keys, credential] = await Promise.all([
    peekKeylessBreadcrumb(cwd),
    readFolderKeys(cwd).catch((error: unknown) => ({ readError: unreadableFolderReason(error) })),
    readCredential(),
  ]);
  const folder = classifyUnlinkedFolder({
    initToken: Boolean(token),
    credential,
    keys,
    sdkClaimLinkProblem: await sdkClaimLinkProblem(cwd, keys),
  });
  log.debug(`unlinked-folder: ${folder.kind}, credential ${credential}`);
  return folder;
}

/** In `getAuthToken`'s order. A failed read of the stored session counts as none. */
async function readCredential(): Promise<Credential> {
  if (process.env.CLERK_PLATFORM_API_KEY) return "api_key";
  return (await hasStoredCredentials().catch(() => false)) ? "session" : "none";
}

/**
 * `UnlinkedFolderFacts.sdkClaimLinkProblem` for these keys: why an SDK-only
 * folder's claim link can't be used. Only the reason: the claim URL carries a
 * claim token.
 */
export async function sdkClaimLinkProblem(
  cwd: string,
  keys: FolderKeys | { readError: string },
): Promise<string | undefined> {
  if ("readError" in keys || !isSdkOnly(keys) || !keys.publishableKey) return undefined;
  const claimLink = await readSdkClaimLink(cwd);
  return claimLink.status === "unusable" ? claimLink.reason : undefined;
}

/** A command to run again, as a clause and, when it can be echoed, the command. */
export interface Rerun {
  /** In the form `clerk link`'s `rerun` option takes: "run `clerk deploy` again". */
  clause: string;
  /** The command itself, for `examples`. Absent when it can't be echoed: its arguments may hold a secret. */
  command?: string;
  /**
   * The folder every advised command must run in, when it isn't where the
   * command that stopped ran: a project `clerk init` just created. `name` is
   * its path relative to there, for the text; `path` is absolute, for the
   * commands.
   */
  folder?: ProjectFolder;
}

export interface ProjectFolder {
  name: string;
  path: string;
}

/**
 * What agent-mode `clerk link` (or `clerk init` through it) knew when it
 * stopped without linking. Its stop already says why, so the advice adds
 * only what to run, and never sends the agent back into the same stop.
 *
 * A failed list carries `refused` when the credential has to change, saying
 * who refused it (`credentialRefusal`), and `retry`, the command that
 * stopped: the one time the advice is that command, worded as a retry.
 */
export type LinkStop =
  | { autolink: "no_key" }
  | { autolink: "no_match" }
  | { autolink: "couldnt_tell" }
  | { autolink: "list_failed"; refused?: CredentialRefusal; retry: Rerun };

/** The step for a folder: text for after a site's own lead sentence, and its commands. */
export type NextStep = NextStepAdvice;

export interface NextStepContext {
  agent: boolean;
  /**
   * The command to run again once the folder is linked, appended as "Then
   * <clause>." `clerk link`'s own stop passes none: once the folder is
   * linked, rerunning `clerk link` does nothing.
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
  // For a folder whose app isn't in the list, or that has none of its own.
  appsListExisting: {
    command: "clerk apps list --json",
    description: "List your applications, to choose an existing one",
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

/**
 * Whether the folder's app is in no account yet: an init app, or an SDK app
 * whose claim link works. Until it's claimed, no app ID reaches it.
 */
export function appInNoAccount(folder: UnlinkedFolder): boolean {
  return folder.kind === "init_app" || (folder.kind === "sdk_app" && !folder.unusable);
}

/**
 * An app `clerk init` or a Clerk SDK created: the only kinds a message calls
 * unclaimed. Plain keys may belong to an app already in an account.
 */
export function isUnclaimedApp(folder: UnlinkedFolder): boolean {
  return folder.kind === "init_app" || folder.kind === "sdk_app";
}

/**
 * The step for `folder` in the current mode, for an error. Agents get its
 * commands as `examples`; a person's text already names them, and
 * `reportError` would print them again as an "Examples:" block.
 */
export function stepInCurrentMode(
  folder: UnlinkedFolder,
  rerun?: Rerun,
): { text: string; examples?: Example[] } {
  const agent = isAgent();
  const step = unlinkedFolderNextStep(folder, { agent, rerun });
  return { text: step.text, ...(agent && { examples: step.examples }) };
}

/**
 * How a command names the app the folder's secret key reaches: "this
 * accountless application" only for an app in no account yet; plain keys, or
 * an SDK app whose claim link can't be used, may already be in one.
 */
export function keylessAppLabel(folder: UnlinkedFolder, source: string): string {
  return `${appInNoAccount(folder) ? "this accountless application" : "this folder's application"} (secret key from ${source})`;
}

/**
 * What a refusal from a command running on the folder's secret key says: what
 * the key from `source` reaches, the step for what `folder` holds, and its
 * commands for an agent.
 */
export function keylessRefusal(
  folder: UnlinkedFolder,
  source: string,
  rerun?: Rerun,
): { subject: KeylessSubject; step: string; examples?: Example[] } {
  const { text, examples } = stepInCurrentMode(folder, rerun);
  return { subject: { unclaimed: appInNoAccount(folder), source }, step: text, examples };
}

/**
 * The `not_linked` error for a command that stopped in `folder`: `lead`, the
 * step for what the folder holds, then `tail`.
 */
export function unlinkedFolderError(
  folder: UnlinkedFolder,
  { lead, tail, rerun }: { lead: string; tail?: string; rerun?: Rerun },
): CliError {
  const step = stepInCurrentMode(folder, rerun);
  return new CliError([lead, step.text, tail].filter(Boolean).join(" "), {
    code: ERROR_CODE.NOT_LINKED,
    examples: step.examples,
  });
}

/** The step for `folder`: the text to put after a site's own lead sentence, and its commands. */
export function unlinkedFolderNextStep(folder: UnlinkedFolder, context: NextStepContext): NextStep {
  const { agent, rerun, linkStop } = context;
  const retry = linkStop?.autolink === "list_failed" ? linkStop.retry : undefined;
  const step =
    agent && linkStop
      ? afterLinkStop(folder, linkStop, rerun)
      : withRerun(stepFor(folder, agent, isSignedIn(folder.credential)), rerun);
  return inFolder(step, rerun?.folder ?? retry?.folder);
}

function stepFor(folder: UnlinkedFolder, agent: boolean, signedIn: boolean): NextStep {
  switch (folder.kind) {
    case "init_app":
      return initApp(agent, signedIn);
    case "sdk_app":
      return folder.unusable
        ? unusableSdkApp(folder.unusable, agent, signedIn)
        : sdkApp(agent, signedIn ? folder.credential : "none");
    case "unknown_owner":
      return unknownOwner(folder, agent, signedIn);
    case "no_app":
      return noApp(agent, signedIn);
  }
}

/** After agent-mode `clerk link` stopped: never back into the same stop. */
function afterLinkStop(
  stopped: UnlinkedFolder,
  stop: LinkStop,
  rerun: Rerun | undefined,
): NextStep {
  // The stop's reason already says the secret keys disagree.
  const folder: UnlinkedFolder =
    stopped.kind === "unknown_owner" ? { ...stopped, secretKeysDisagree: undefined } : stopped;
  const signedIn = isSignedIn(folder.credential);
  if (stop.autolink === "list_failed") {
    // Without a credential, the list never reached Clerk.
    if (stop.refused || !signedIn) {
      return afterRefusal(folder, stop.refused ?? "cli", stop.retry, rerun);
    }
    return retryThenLinkById(folder, stop.retry, rerun);
  }
  // Without a credential, `link` skipped the claim: signing in claims the app.
  if (!signedIn && folder.kind === "init_app") return withRerun(initApp(true, false), rerun);
  switch (stop.autolink) {
    case "couldnt_tell":
      // The stop's reason already says why.
      return withRerun(chooseById(undefined, signedIn, "folders_app"), rerun);
    case "no_match":
      return withRerun(noMatch(folder, signedIn), rerun);
    case "no_key":
      return withRerun(noKey(folder, signedIn), rerun);
  }
}

/**
 * Clerk refused the credential a Platform API call used, or there was none:
 * the list `link` matches with, or `link`'s claim of an init app. Retrying
 * can't fix it; the credential has to change, then `retry` (the command that
 * stopped) runs again. A credential problem isn't proof the app needs
 * claiming, so after the fix the retry decides.
 */
export function afterRefusedCredential(
  folder: UnlinkedFolder,
  refusal: CredentialRefusal,
  retry: Rerun,
  rerun: Rerun | undefined,
): NextStep {
  return inFolder(afterRefusal(folder, refusal, retry, rerun), rerun?.folder ?? retry.folder);
}

function afterRefusal(
  folder: UnlinkedFolder,
  refusal: CredentialRefusal,
  retry: Rerun,
  rerun: Rerun | undefined,
): NextStep {
  // Platform API calls use the key over any session, so signing in can't help.
  if (folder.credential === "api_key") return fixApiKey(retry);
  // Only a session Clerk's API refused can still pass the account lookup,
  // which makes agent `clerk auth login` keep it: it's signed out first.
  if (folder.credential === "session" && refusal === "clerk") {
    return folder.kind === "init_app"
      ? withRerun(signInAgainToClaim(), rerun)
      : signInAgainThenRetry(retry);
  }
  // No credential, or a session the CLI can't use, reads as signed out, so
  // signing in replaces it. An init app's sign-in claims and links it.
  return folder.kind === "init_app"
    ? withRerun(initApp(true, false), rerun)
    : signInThenRetry(retry);
}

/** No app in the account holds the folder's key. */
function noMatch(folder: UnlinkedFolder, signedIn: boolean): NextStep {
  switch (folder.kind) {
    case "sdk_app":
      // The SDK's app isn't in the account, so listing the account to link by
      // ID would pick another app. A claimable one is claimed first; one that
      // can't be claimed leaves only an existing app, as `link`'s stop says.
      // `link`'s stop already says the Clerk SDK created the app, so a
      // claimable one's advice doesn't open by saying it again.
      return folder.unusable
        ? chooseById(noUsableClaimLinkSentence(folder.unusable.reason), signedIn, "existing_app")
        : claimThenLink(signedIn ? folder.credential : "none");
    case "unknown_owner": {
      const where = folder.publishableKey ? ` (${describeKeyLocation(folder.publishableKey)})` : "";
      return chooseById(
        `No application in ${searched(folder.credential)} uses this folder's publishable key${where}.`,
        signedIn,
        "existing_app",
      );
    }
    case "init_app":
    case "no_app":
      return chooseById(
        `No application in ${searched(folder.credential)} uses this folder's publishable key.`,
        signedIn,
        "existing_app",
      );
  }
}

/** Auto-link found no publishable key the folder's app loads. */
function noKey(folder: UnlinkedFolder, signedIn: boolean): NextStep {
  if (!signedIn) return stepFor(folder, true, false);
  switch (folder.kind) {
    case "no_app":
      // Today's wording at this stop, kept.
      return {
        text: "Pass --app <id>, or run `clerk apps list --json` and retry.",
        examples: [EXAMPLE.appsListExisting, EXAMPLE.linkById],
      };
    case "init_app":
      // A signed-in agent's `link` already claimed the token, so one still on
      // disk is spent: `clerk link` would stop here again.
      return chooseById(undefined, true, "folders_app");
    case "sdk_app":
      // `clerk link` would stop again on a file it can't claim from.
      return folder.unusable
        ? chooseById(noUsableClaimLinkSentence(folder.unusable.reason), true, "existing_app")
        : sdkApp(true, folder.credential);
    case "unknown_owner":
      // With a publishable key, `clerk link` would stop here again.
      return folder.publishableKey
        ? chooseById(undefined, true, "folders_app")
        : unknownOwner(folder, true, true);
  }
}

/** Where `clerk apps list` searched: the API key's workspace wins over a session's account. */
function searched(credential: Credential): string {
  return credential === "api_key"
    ? "the workspace `CLERK_PLATFORM_API_KEY` belongs to"
    : "your account";
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

/**
 * Where a person must claim an SDK-created app for the agent's next
 * `clerk link` to find it: the account or workspace its credential reaches.
 */
const CLAIM_INTO: Record<Credential, string> = {
  api_key: "the workspace `CLERK_PLATFORM_API_KEY` belongs to",
  session: "the account this CLI is signed in to",
  none: "the account `clerk auth login` will sign in to",
};

function sdkApp(agent: boolean, credential: Credential): NextStep {
  const lead = "This folder runs on an app the Clerk SDK created during development.";
  if (!agent) {
    return {
      text: `${lead} Run \`clerk link\`: it links the app if it's in your account, or opens the Clerk Dashboard page to claim it. After claiming it, run \`clerk link\` again.`,
      examples: [
        { command: "clerk link", description: "Link the app, or open the page to claim it" },
      ],
    };
  }
  const step = claimThenLink(credential);
  return { ...step, text: `${lead} ${step.text}` };
}

/** An agent can't claim an SDK-created app; a person does, from the link `clerk open` prints. */
function claimThenLink(credential: Credential): NextStep {
  const linkClaimed = { command: "clerk link", description: "Link the app once it's claimed" };
  const open = `Run \`clerk open\` to print its claim link for a person to claim the app into ${CLAIM_INTO[credential]}`;
  return isSignedIn(credential)
    ? {
        text: `${open}, then \`clerk link\` once it's claimed.`,
        examples: [EXAMPLE.open, linkClaimed],
      }
    : {
        text: `${open}, then ${SIGN_IN}, then \`clerk link\` once it's claimed.`,
        examples: [EXAMPLE.open, EXAMPLE.signIn, linkClaimed],
      };
}

function unusableSdkApp(problem: SdkClaimProblem, agent: boolean, signedIn: boolean): NextStep {
  const lead = noUsableClaimLinkSentence(problem.reason);
  if (problem.findableByKey) {
    // `clerk link` finds the app by its key if it's already in the account,
    // and otherwise stops saying to link by ID, so this can't loop.
    const find =
      "`clerk link`: it links the app if it's already in your account, and otherwise says to link one with `clerk link --app <app_id>`";
    const linkByKey = {
      command: "clerk link",
      description: "Link the app if it's already in your account",
    };
    return agent && !signedIn
      ? { text: `${lead} Run ${SIGN_IN}, then ${find}.`, examples: [EXAMPLE.signIn, linkByKey] }
      : { text: `${lead} Run ${find}.`, examples: [linkByKey] };
  }
  // No key to find it by: `clerk link`'s own stop, before any sign-in or list.
  if (!agent) {
    return { text: `${lead} ${LINK_EXISTING_APP_SENTENCE}`, examples: [EXAMPLE.linkById] };
  }
  return chooseById(lead, signedIn, "existing_app");
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
    return agent ? chooseById(lead, signedIn, "folders_app") : pickInLink(lead);
  }
  // First, so a command that found no secret key to run on says why.
  const disagree = folder.secretKeysDisagree ? `${capitalize(folder.secretKeysDisagree)}. ` : "";
  if (folder.publishableKey) {
    const lead = `${disagree}This folder's Clerk publishable key is ${describeKeyLocation(folder.publishableKey)}.`;
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
    : `${disagree}This folder has Clerk secret keys but no publishable key, so \`clerk link\` can't match them to an application.`;
  return agent ? chooseById(lead, signedIn, "folders_app") : pickInLink(lead);
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
    ? {
        text: `Run ${choose}.`,
        examples: [EXAMPLE.appsListExisting, EXAMPLE.linkById, EXAMPLE.init],
      }
    : {
        text: `Run ${SIGN_IN} first, then ${choose}.`,
        examples: [EXAMPLE.signIn, EXAMPLE.appsListExisting, EXAMPLE.linkById, EXAMPLE.init],
      };
}

/** A person's `clerk link` shows the picker here, after saying why it can't match. */
function pickInLink(lead: string): NextStep {
  return {
    text: `${lead} Run \`clerk link\` and choose the app this folder uses.`,
    examples: [{ command: "clerk link", description: "Choose the application this folder uses" }],
  };
}

/**
 * Which app an agent picks from the list: the folder's own, when it may be
 * there, or an existing one, when the folder's app isn't in the list or can't
 * be found by key (`link`'s own wording for that case).
 */
type Pick = "folders_app" | "existing_app";

const PICK: Record<Pick, { closing: string; list: Example }> = {
  folders_app: { closing: "with the app this folder uses", list: EXAMPLE.appsList },
  existing_app: {
    closing: "to link an existing application instead",
    list: EXAMPLE.appsListExisting,
  },
};

/** For an agent, which can't use the picker: list the apps, then link one by ID. */
function chooseById(lead: string | undefined, signedIn: boolean, pick: Pick): NextStep {
  const { closing, list } = PICK[pick];
  const choose = `\`clerk apps list --json\`, then \`clerk link --app <app_id>\` ${closing}`;
  const action = signedIn ? `Run ${choose}.` : `Run ${SIGN_IN}, then ${choose}.`;
  return {
    text: lead ? `${lead} ${action}` : action,
    examples: signedIn ? [list, EXAMPLE.linkById] : [EXAMPLE.signIn, list, EXAMPLE.linkById],
  };
}

/**
 * The key Platform API calls use was refused, or isn't a Platform API key.
 * Signing in can't help while it's set, so the person fixes or removes it,
 * then the command that stopped runs again.
 */
function fixApiKey(retry: Rerun): NextStep {
  return {
    text: `Replace \`CLERK_PLATFORM_API_KEY\` with a working Platform API key, or unset it and sign in with ${SIGN_IN}. Then ${retry.clause}.`,
    examples: retry.command
      ? [
          {
            command: retry.command,
            description: "Run it again once CLERK_PLATFORM_API_KEY is replaced or unset",
          },
        ]
      : [],
  };
}

/**
 * Agent-mode `clerk auth login` keeps a stored session that still passes the
 * account lookup, even one the Platform API refuses, so signing out first is
 * what makes it sign in again. Signing out applies to the whole machine, and
 * the same account may be refused again, so the text says both.
 */
const SIGN_OUT_THEN_IN =
  "`clerk auth logout` (it signs the CLI out on this whole machine, not just this folder), then `clerk auth login` (it opens a browser, so a person must finish signing in, with an account that can list applications)";

const SIGN_OUT = { command: "clerk auth logout", description: "Sign the CLI out on this machine" };
const SIGN_IN_AGAIN = {
  command: "clerk auth login",
  description: "Sign in again; a person finishes it, with an account that can list applications",
};

/** Clerk refused the stored session: sign out, sign in again, then run the command that stopped again. */
function signInAgainThenRetry(retry: Rerun): NextStep {
  return {
    text: `Clerk refused this CLI's stored session. Run ${SIGN_OUT_THEN_IN}, then ${retry.clause}.`,
    examples: [
      SIGN_OUT,
      SIGN_IN_AGAIN,
      ...(retry.command
        ? [{ command: retry.command, description: "Run it again once signed in" }]
        : []),
    ],
  };
}

/** The same, for an init app: signing in again claims it and links this folder. */
function signInAgainToClaim(): NextStep {
  return {
    text: `Clerk refused this CLI's stored session, and this folder's app was created by \`clerk init\` and isn't in an account yet. Run ${SIGN_OUT_THEN_IN}: signing in claims the app and links this folder.`,
    examples: [
      SIGN_OUT,
      {
        ...SIGN_IN_AGAIN,
        description: `${SIGN_IN_AGAIN.description}; it claims this folder's app`,
      },
    ],
  };
}

/** The list failed on its credential: sign in, then run the command that stopped again. */
function signInThenRetry(retry: Rerun): NextStep {
  return {
    text: `Run ${SIGN_IN}, then ${retry.clause}.`,
    examples: [
      EXAMPLE.signIn,
      ...(retry.command
        ? [{ command: retry.command, description: "Run it again once signed in" }]
        : []),
    ],
  };
}

/**
 * A list that failed for a reason other than its credential can be temporary,
 * so the advice is the command that stopped, as a retry. One that keeps
 * failing (a server bug on one account, say) would loop on retries alone, so
 * the same message offers linking by an ID from the Dashboard: that's a
 * different API call, so it can work while the list doesn't.
 *
 * An SDK-created app is in the Dashboard only once someone claims it. Looking
 * up "its" ID before that could pick another app, which `clerk link --app`
 * links without checking the folder's keys, so a claimable one is claimed
 * first, where the retry searches. One that can't be claimed from this folder
 * is named as the folder's own app only if it's already claimed; any other app
 * is a separate choice. This stop comes before `link` could say so.
 */
function retryThenLinkById(
  folder: UnlinkedFolder,
  retry: Rerun,
  rerun: Rerun | undefined,
): NextStep {
  const thenRerun = rerun ? `, then ${rerun.clause}` : "";
  const linkById = "run `clerk link --app <app_id>`";
  // A person who guesses could pick another app, so they find it by its key.
  const which = appByKey(folder);
  let fallback = `have a person find the app's ID in the Clerk Dashboard${which} and ${linkById}${thenRerun}.`;
  let byIdWhen = "If it fails again";
  const openFirst: Example[] = [];
  if (folder.kind === "sdk_app" && !folder.unusable) {
    fallback = `have a person claim the app from the link \`clerk open\` prints, into ${CLAIM_INTO[folder.credential]}, if it isn't there yet, then find its ID in the Clerk Dashboard and ${linkById}${thenRerun}.`;
    openFirst.push(EXAMPLE.open);
  } else if (folder.kind === "sdk_app" && folder.unusable) {
    fallback = `if this folder's app is already claimed, have a person find its ID in the Clerk Dashboard${which} and ${linkById}${thenRerun}. ${noUsableClaimLinkSentence(folder.unusable.reason)} So if the app isn't claimed yet, it can't be claimed from this folder, and linking an existing application instead is a separate choice.`;
    byIdWhen = "If it fails again, and only if this folder's app is already claimed";
  }
  return {
    text: `A failed list can be temporary, so retry: ${retry.clause}. If it fails again, ${fallback}`,
    examples: [
      ...(retry.command ? [{ command: retry.command, description: "Retry" }] : []),
      ...openFirst,
      {
        command: "clerk link --app <app_id>",
        description: `${byIdWhen}: link the app by the ID a person finds in the Clerk Dashboard`,
      },
      ...(rerun?.command
        ? [{ command: rerun.command, description: "Run it again once this folder is linked" }]
        : []),
    ],
  };
}

/**
 * How a person picks the folder's own app out of the Dashboard: by the key
 * the folder holds, as a parenthetical; empty when it holds none.
 */
function appByKey(folder: UnlinkedFolder): string {
  if (folder.kind === "sdk_app") {
    return folder.unusable?.findableByKey === false
      ? ""
      : ` (the one whose publishable key matches the one in \`${SDK_KEYLESS_SOURCE}\`)`;
  }
  if (folder.kind !== "unknown_owner") return "";
  if (folder.publishableKey) {
    return ` (the one whose publishable key is ${describeKeyLocation(folder.publishableKey)})`;
  }
  if (folder.secretKey) {
    return ` (the one whose secret key is ${describeKeyLocation(folder.secretKey)})`;
  }
  return "";
}

/**
 * Names the project's folder and changes into it before each command, when
 * the commands must run somewhere other than where the command that stopped
 * ran (`Rerun.folder`). From there, `clerk link` would link the wrong folder
 * and `clerk init` could scaffold a second project. Some agents run each
 * command in a new shell, so every command carries its own `cd`; others keep
 * the shell's folder between commands, so the `cd` takes the absolute path,
 * which works from anywhere, including the project's own folder.
 */
function inFolder(step: NextStep, folder: ProjectFolder | undefined): NextStep {
  if (!folder) return step;
  const cd = `cd ${quoteArg(folder.path)} && `;
  return {
    text: `Run these commands in \`${folder.name}\`, the project's folder. ${step.text}`,
    examples: step.examples.map((example) => ({ ...example, command: `${cd}${example.command}` })),
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
