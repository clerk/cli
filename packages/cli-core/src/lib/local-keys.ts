/**
 * The Clerk keys a folder's app actually loads, read from the folder alone.
 *
 * A leaf module on purpose: it must not import `lib/config.ts`, directly or
 * through `lib/keyless-target.ts`, because `lib/config.ts` will need it to word
 * its not-linked errors. `lib/keyless-target.ts` re-exports the helpers that
 * used to live there, so their importers are unchanged.
 */

import { join } from "node:path";
import { parseEnvFile } from "./dotenv.ts";
import { detectPublishableKeyName, detectSecretKeyName } from "./framework.ts";

export interface LocatedKey {
  value: string;
  /** Where the key came from, for display (`CLERK_SECRET_KEY env var`, `.env.local`). */
  source: string;
}

/** A folder's keys, each from wherever the app would load it; absent when it holds none. */
export interface FolderKeys {
  publishableKey?: LocatedKey;
  secretKey?: LocatedKey;
}

const ENV_FILES = [".env", ".env.local"];

/**
 * Where the Clerk SDKs park the keys for a keyless app they created themselves
 * (running `next dev` with no keys configured). Shape:
 * `{ publishableKey, secretKey, claimUrl, apiKeysUrl }`.
 */
const SDK_KEYLESS_FILE = [".clerk", ".tmp", "keyless.json"];

/**
 * The `source` a key found in the SDK's own keyless file carries. Exported so
 * a caller can tell that source apart without restating the path.
 */
export const SDK_KEYLESS_SOURCE = SDK_KEYLESS_FILE.join("/");

/**
 * Reads the SDK's own keyless file, ignoring a partially-written one.
 * Exported for `init`, whose keep-the-existing-app guard must recognise an
 * application the SDK minted for itself just as readily as one `clerk init`
 * minted — the two files describe the same kind of unclaimed app.
 */
export async function readSdkKeylessApp(
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

/**
 * Looks for a key under any of `names`, in the order the app itself would
 * resolve one: the environment first, then env files with a later file
 * overriding an earlier one.
 */
export async function findKeyInProject(
  cwd: string,
  names: string[],
): Promise<LocatedKey | undefined> {
  for (const name of new Set(names)) {
    const value = process.env[name];
    if (value) return { value, source: `${name} env var` };
  }

  // Priority is by name, not by position: the framework-specific name beats
  // the generic fallback even when the generic one appears later in the same
  // file. Within one name, a later file still overrides an earlier one.
  const foundByName = new Map<string, LocatedKey>();
  for (const envFile of ENV_FILES) {
    const file = Bun.file(join(cwd, envFile));
    if (!(await file.exists())) continue;

    for (const line of parseEnvFile(await file.text())) {
      if (line.type !== "entry" || !line.value) continue;
      if (names.includes(line.key)) {
        foundByName.set(line.key, { value: line.value, source: envFile });
      }
    }
  }

  for (const name of names) {
    const located = foundByName.get(name);
    if (located) return located;
  }
  return undefined;
}

/**
 * The publishable and secret key the folder's app loads, each with its source.
 *
 * Plain keys (an env var, `.env.local`, `.env`) come in the order the app
 * resolves them. The SDK's keyless file counts only when the folder has no
 * plain key of either kind, and then both keys come from it: the SDK writes
 * that file only when nothing else configures Clerk, so a plain key means the
 * app runs on the plain keys, and pairing one with the SDK file's other key
 * would describe two different apps as one.
 *
 * Keys are returned as found, never validated, so a malformed key can't make
 * a caller fail with a key-format error. A filesystem error (an unreadable env
 * file) propagates: callers must not mistake "couldn't read" for "no keys".
 */
export async function readFolderKeys(cwd: string): Promise<FolderKeys> {
  const [publishableKeyName, secretKeyName] = await Promise.all([
    detectPublishableKeyName(cwd),
    detectSecretKeyName(cwd),
  ]);
  const [publishableKey, secretKey] = await Promise.all([
    findKeyInProject(cwd, [publishableKeyName, "CLERK_PUBLISHABLE_KEY"]),
    findKeyInProject(cwd, [secretKeyName, "CLERK_SECRET_KEY"]),
  ]);
  if (publishableKey || secretKey) return { publishableKey, secretKey };

  const sdkApp = await readSdkKeylessApp(cwd);
  return {
    publishableKey: sdkApp?.publishableKey
      ? { value: sdkApp.publishableKey, source: SDK_KEYLESS_SOURCE }
      : undefined,
    secretKey: sdkApp?.secretKey
      ? { value: sdkApp.secretKey, source: SDK_KEYLESS_SOURCE }
      : undefined,
  };
}
