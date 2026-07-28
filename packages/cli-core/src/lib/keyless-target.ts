/**
 * Finding and addressing an unclaimed keyless application from the files a
 * project already has on disk.
 *
 * Commands that can operate on an instance directly (config, feature toggles,
 * whoami, env) resolve a target through here so the account and keyless paths
 * are decided once, the same way, everywhere.
 */

import { join } from "node:path";
import { bapiRequest } from "./bapi.ts";
import { resolveAppContext, resolveProfile } from "./config.ts";
import { getStoredSession, hasAccountCredentials, type OAuthSession } from "./credential-store.ts";
import { parseEnvFile } from "./dotenv.ts";
import { CliError, ERROR_CODE, throwUsageError } from "./errors.ts";
import { decodePublishableKey } from "./fapi.ts";
import { detectPublishableKeyName, detectSecretKeyName } from "./framework.ts";
import { log } from "./log.ts";

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
  | { kind: "keyless"; keyless: KeylessTarget; label: string };

const ENV_FILES = [".env", ".env.local"];

/**
 * Where the Clerk SDKs park the keys for a keyless app they created themselves
 * (running `next dev` with no keys configured). Shape:
 * `{ publishableKey, secretKey, claimUrl, apiKeysUrl }`.
 */
const SDK_KEYLESS_FILE = [".clerk", ".tmp", "keyless.json"];

/** Reads the SDK's own keyless file, ignoring a partially-written one. */
async function readSdkKeylessApp(
  cwd: string,
): Promise<{ secretKey?: string; publishableKey?: string } | undefined> {
  const file = Bun.file(join(cwd, ...SDK_KEYLESS_FILE));
  if (!(await file.exists())) return undefined;

  try {
    const parsed = (await file.json()) as { secretKey?: unknown; publishableKey?: unknown };
    return {
      secretKey: typeof parsed.secretKey === "string" ? parsed.secretKey : undefined,
      publishableKey: typeof parsed.publishableKey === "string" ? parsed.publishableKey : undefined,
    };
  } catch {
    // A half-written file during an SDK refresh isn't worth failing over.
    return undefined;
  }
}

interface LocatedKey {
  value: string;
  source: string;
}

/**
 * Looks for a key under any of `names`, in the order the app itself would
 * resolve one: the environment first, then env files with a later file
 * overriding an earlier one.
 */
async function findKeyInProject(cwd: string, names: string[]): Promise<LocatedKey | undefined> {
  for (const name of new Set(names)) {
    const value = process.env[name];
    if (value) return { value, source: `${name} env var` };
  }

  let found: LocatedKey | undefined;
  for (const envFile of ENV_FILES) {
    const file = Bun.file(join(cwd, envFile));
    if (!(await file.exists())) continue;

    for (const line of parseEnvFile(await file.text())) {
      if (line.type !== "entry" || !line.value) continue;
      if (names.includes(line.key)) found = { value: line.value, source: envFile };
    }
  }

  return found;
}

/**
 * The instance secret key a keyless project keeps locally. Falls back to the
 * keys an SDK created for itself, which it only does when nothing else supplies
 * them — so that file goes last.
 */
export async function findLocalSecretKey(cwd: string): Promise<KeylessTarget | undefined> {
  const names = [await detectSecretKeyName(cwd), "CLERK_SECRET_KEY"];
  const located = await findKeyInProject(cwd, names);

  const found = located
    ? { secretKey: located.value, source: located.source }
    : await sdkKeylessTarget(cwd);

  if (found) log.debug(`keyless: secret key from ${found.source}`);
  return found;
}

async function sdkKeylessTarget(cwd: string): Promise<KeylessTarget | undefined> {
  const sdkApp = await readSdkKeylessApp(cwd);
  if (!sdkApp?.secretKey) return undefined;
  return { secretKey: sdkApp.secretKey, source: SDK_KEYLESS_FILE.join("/") };
}

/** The publishable key a keyless project holds locally, when one can be found. */
export async function findLocalPublishableKey(cwd: string): Promise<string | undefined> {
  const names = [await detectPublishableKeyName(cwd), "CLERK_PUBLISHABLE_KEY"];
  const located = await findKeyInProject(cwd, names);

  return located?.value ?? (await readSdkKeylessApp(cwd))?.publishableKey;
}

/**
 * Whether a publishable key found locally does NOT belong to the same
 * application as a secret key found locally. `findLocalSecretKey` and
 * `findLocalPublishableKey` search independently — nothing stops one from
 * returning app A's key and the other app B's, e.g. two keyless apps whose
 * keys both happen to sit in the same `.env.local`. Presenting or writing
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
export async function resolveKeylessTarget(options: {
  app?: string;
  instance?: string;
  cwd?: string;
}): Promise<KeylessTarget | undefined> {
  if (options.app) return undefined;

  const cwd = options.cwd ?? process.cwd();
  if (await resolveProfile(cwd)) return undefined;

  const target = await findLocalSecretKey(cwd);
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
    throwUsageError(
      `--instance is not supported for an unclaimed keyless application: the secret key in ${target.source} already targets its own instance.\n` +
        "Run `clerk auth login` to claim the application, then target instances by name.",
    );
  }

  return target;
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
async function warnKeylessCoversLess(source: string): Promise<void> {
  if (!(await hasAccountCredentials())) return;

  // A platform API key never expires this way and is on its own enough to link,
  // so it always gets the plain wording.
  if (process.env.CLERK_PLATFORM_API_KEY) {
    log.warn(
      `This directory isn't linked to an application — using the secret key from ${source}, which covers fewer settings.\n` +
        "Run `clerk link` (or pass --app <app_id>) to use the full configuration.",
    );
    return;
  }

  const session = await getStoredSession();
  log.warn(
    session && isLocallyExpired(session)
      ? `This directory isn't linked to an application, and the stored session has expired — using the secret key from ${source}, which covers fewer settings.\n` +
          "Run `clerk auth login` to re-authenticate, then `clerk link` (or pass --app <app_id>) to use the full configuration."
      : `This directory isn't linked to an application — using the secret key from ${source}, which covers fewer settings.\n` +
          "Run `clerk link` (or pass --app <app_id>) to use the full configuration.",
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
}): Promise<InstanceTarget> {
  const keyless = await resolveKeylessTarget(options);
  if (keyless) {
    await warnKeylessCoversLess(keyless.source);
    return {
      kind: "keyless",
      keyless,
      label: `this keyless application (secret key from ${keyless.source})`,
    };
  }

  const ctx = await resolveAppContext(options);
  return { kind: "account", ctx, label: `${ctx.appLabel} (${ctx.instanceLabel})` };
}
