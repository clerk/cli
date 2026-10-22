/**
 * Finding and addressing an unclaimed keyless application from the files a
 * project already has on disk.
 *
 * Commands that can operate on an instance directly (config, feature toggles,
 * whoami, env) resolve a target through here so the account and keyless paths
 * are decided once, the same way, everywhere.
 */

import { bapiRequest } from "./bapi.ts";
import { resolveAppContext, resolveProfile } from "./config.ts";
import { getStoredSession, hasAccountCredentials, type OAuthSession } from "./credential-store.ts";
import { CliError, ERROR_CODE, throwUsageError } from "./errors.ts";
import { decodePublishableKey } from "./fapi.ts";
import {
  ENV_VAR_SOURCE_SUFFIX,
  exportedFolderKey,
  readFolderKeys,
  readSdkKeylessApp,
  SDK_KEYLESS_SOURCE,
  unreadableFolderReason,
  type FolderKeys,
  type FolderRead,
  type LocatedKey,
} from "./local-keys.ts";
import { log } from "./log.ts";
import { keylessCopy } from "./copy.ts";
import {
  keylessAppLabel,
  keylessRefusal,
  readUnlinkedFolder,
  unlinkedFolderNextStep,
  type UnlinkedFolder,
} from "./unlinked-folder.ts";
import { isAgent } from "../mode.ts";

// Defined in the leaf module `local-keys.ts`; re-exported for this module's importers.
export { ENV_VAR_SOURCE_SUFFIX, readSdkKeylessApp, SDK_KEYLESS_SOURCE };

export interface KeylessTarget {
  secretKey: string;
  /** Where the key came from, for display (`CLERK_SECRET_KEY env var`, `.env.local`). */
  source: string;
}

export interface AccountContext {
  appId: string;
  appLabel: string;
  instanceId: string;
  instanceLabel: string;
}

/**
 * Where a command should send its reads and writes. Resolve this once and
 * branch on `kind`, so the account and keyless paths can't drift per command.
 */
export type InstanceTarget =
  | { kind: "account"; ctx: AccountContext; label: string }
  | { kind: "keyless"; keyless: KeylessTarget; label: string; folder: UnlinkedFolder };

export type KeylessInstanceTarget = Extract<InstanceTarget, { kind: "keyless" }>;

/**
 * The secret key the folder's app loads (`readFolderKeys`), the key `clerk
 * link` and the unlinked-folder advice read: in the framework's env load
 * order, or from the SDK keyless file when the folder holds no plain key.
 * Undefined when there's none, or when the files disagree and no load order
 * says which the app loads.
 */
export async function findLocalSecretKey(
  cwd: string,
  keys?: FolderKeys,
): Promise<KeylessTarget | undefined> {
  return (await readSecretKey(cwd, keys)).target;
}

/** `findLocalSecretKey`, and the read of the folder's keys it made. */
async function readSecretKey(
  cwd: string,
  keys: FolderKeys | undefined,
): Promise<{ target?: KeylessTarget; read: FolderRead }> {
  let read: FolderRead;
  let secretKey: LocatedKey | undefined;
  try {
    const folderKeys = keys ?? (await readFolderKeys(cwd));
    read = folderKeys;
    secretKey = folderKeys.secretKey;
  } catch (error) {
    // An exported key is the one the app loads, so an env file that can't be
    // read doesn't stop a command that needs only that key.
    secretKey = await exportedFolderKey(cwd, "secret");
    if (!secretKey) throw error;
    read = { readError: unreadableFolderReason(error) };
  }
  if (!secretKey) return { read };
  log.debug(`accountless: secret key from ${secretKey.source}`);
  return { target: { secretKey: secretKey.value, source: secretKey.source }, read };
}

/** The publishable key the folder's app loads, and where, read as `findLocalSecretKey` reads it. */
export async function findLocalPublishableKey(cwd: string): Promise<LocatedKey | undefined> {
  return (await readFolderKeys(cwd)).publishableKey;
}

/**
 * Whether a publishable key found locally does NOT belong to the same
 * application as a secret key found locally. Each plain key is the one the
 * app loads, but nothing stops one being app A's and the other app B's, e.g.
 * leftovers from two apps in the same `.env.local`. Presenting or writing
 * that pair as one identity produces an app that fails at runtime in a way
 * that's very hard to trace: the server trusts one app, the browser talks to
 * another.
 *
 * `GET /v1/instance` doesn't echo a publishable key back for an unclaimed
 * keyless app, so the only BAPI route that names the Frontend API host a
 * secret key addresses is `/v1/domains` — every instance has at least one.
 * Comparing that host against the one the publishable key decodes to
 * (`decodePublishableKey` in `lib/fapi.ts`) is sound: unlike comparing
 * `_test_`/`_live_` prefixes, a same-environment key from a different
 * application can never pass it, and a legitimately matched pair always will.
 *
 * A malformed publishable key isn't this check's problem to report — callers
 * that need `sk_`/`pk_` validation already do it elsewhere — so it resolves
 * to "no mismatch" rather than throwing.
 */
export async function hasKeyPairMismatch(
  keyless: KeylessTarget,
  publishableKey: string,
): Promise<boolean> {
  let fapiHost: string;
  try {
    fapiHost = decodePublishableKey(publishableKey).fapiHost;
  } catch {
    return false;
  }

  const response = await bapiRequest({
    method: "GET",
    path: "/v1/domains",
    secretKey: keyless.secretKey,
  });
  const domains = (response.body as { data?: unknown }).data;
  if (!Array.isArray(domains)) return false;

  const matchesADomain = domains.some((domain) => {
    const frontendApiUrl = (domain as { frontend_api_url?: unknown }).frontend_api_url;
    if (typeof frontendApiUrl !== "string") return false;
    try {
      return new URL(frontendApiUrl).host === fapiHost;
    } catch {
      return false;
    }
  });

  return !matchesADomain;
}

/**
 * Resolves the keyless target for a command, or `undefined` when the
 * account-authenticated path applies.
 *
 * Account credentials are deliberately NOT part of this decision: these
 * commands must work from the instance secret key alone, with or without a
 * platform API key or a login session. What rules keyless out is an explicit
 * destination — `--app` or a linked profile — because that names an application
 * the secret key on disk may not even belong to.
 */
export async function resolveKeylessTarget(
  options: KeylessTargetOptions,
): Promise<KeylessTarget | undefined> {
  return (await resolveKeylessTargetAndRead(options))?.target;
}

interface KeylessTargetOptions {
  app?: string;
  instance?: string;
  cwd?: string;
  /**
   * The folder's keys, when the caller already read them (`readFolderKeys`).
   * Not `keys`: `config pull` and `config schema` pass their `--keys` here.
   */
  folderKeys?: FolderKeys;
}

/**
 * `resolveKeylessTarget`, and the read of the folder's keys that found the
 * key, for a caller that also words the folder (`readUnlinkedFolder`).
 */
export async function resolveKeylessTargetAndRead(
  options: KeylessTargetOptions,
): Promise<{ target: KeylessTarget; read: FolderRead } | undefined> {
  if (options.app) return undefined;

  const cwd = options.cwd ?? process.cwd();
  if (await resolveProfile(cwd)) return undefined;

  const { target, read } = await readSecretKey(cwd, options.folderKeys);
  if (!target) return undefined;

  if (!target.secretKey.startsWith("sk_")) {
    throw new CliError(
      `Expected a secret key starting with \`sk_\` in ${target.source}, found something else.`,
      { code: ERROR_CODE.INVALID_KEY_FORMAT },
    );
  }

  // The secret key addresses exactly one instance — its own — so there is no
  // instance to choose between.
  if (options.instance) {
    const refusal = keylessRefusal(await readUnlinkedFolder(cwd, read), target.source);
    throwUsageError(
      keylessCopy.instanceFlagNeedsLinkedApplication(refusal.subject, refusal.step),
      undefined,
      undefined,
      refusal.examples,
    );
  }

  return { target, read };
}

/**
 * Says so when a signed-in user is getting the smaller, keyless view of an
 * instance they could be reaching in full.
 *
 * This lives with `resolveInstanceTarget` rather than with the resolution
 * itself because it is only true of the configuration surface: `clerk link`
 * would widen what `config pull` and the feature toggles can see, but it does
 * nothing for `whoami`, `env pull`, `open` or `doctor`, which want the same
 * keyless answer either way. A resolver that warns is also a resolver no
 * diagnostic tool can call without polluting its own report.
 *
 * `hasAccountCredentials` only tests presence, so a stored session past its own
 * recorded expiry would otherwise be pointed at `clerk link`, which can't
 * succeed until the user logs in again. Checking the token's real validity
 * would mean a refresh round trip on every keyless command just to word a
 * warning, so this reads the expiry already cached alongside the session — no
 * network call, and right in the common case of a session stale by its own
 * clock rather than one the server revoked.
 */
async function warnKeylessCoversLess(source: string, folder: UnlinkedFolder): Promise<void> {
  if (!(await hasAccountCredentials())) return;

  const { text: step } = unlinkedFolderNextStep(folder, { agent: isAgent() });

  // A platform API key never expires this way and is on its own enough to link,
  // so it always gets the plain wording.
  const session = process.env.CLERK_PLATFORM_API_KEY ? null : await getStoredSession();
  log.warn(
    session && isLocallyExpired(session)
      ? `This directory isn't linked to an application, and the stored session has expired — using the secret key from ${source}, which covers fewer settings.\n` +
          `Run \`clerk auth login\` to re-authenticate. ${step}`
      : `This directory isn't linked to an application — using the secret key from ${source}, which covers fewer settings.\n${step}`,
  );
}

/**
 * A cheap, local-only proxy for "the account path is currently broken":
 * whether a stored session's own recorded expiry has already passed. This
 * can't see a session the *server* has revoked (that needs the refresh round
 * trip `getValidToken` performs), only one that's stale by its own clock —
 * but that's the common case, and it's the distinction the not-linked warning
 * needs without paying for a network call on every keyless command.
 */
function isLocallyExpired(session: OAuthSession): boolean {
  return Number.isFinite(session.expiresAt) && session.expiresAt <= Date.now();
}

export async function resolveInstanceTarget(options: {
  app?: string;
  instance?: string;
  cwd?: string;
  /**
   * The caller refuses a keyless target, and its refusal gives the folder's
   * step, so the "covers fewer settings" warning would repeat it.
   */
  refusesKeyless?: boolean;
}): Promise<InstanceTarget> {
  const found = await resolveKeylessTargetAndRead(options);
  if (found) {
    const { target: keyless, read } = found;
    const folder = await readUnlinkedFolder(options.cwd ?? process.cwd(), read);
    if (!options.refusesKeyless) await warnKeylessCoversLess(keyless.source, folder);
    return {
      kind: "keyless",
      keyless,
      label: keylessAppLabel(folder, keyless.source),
      folder,
    };
  }

  const ctx = await resolveAppContext(options);
  return { kind: "account", ctx, label: `${ctx.appLabel} (${ctx.instanceLabel})` };
}
