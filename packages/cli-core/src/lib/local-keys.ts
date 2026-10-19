/**
 * The Clerk keys a folder holds, read from the folder alone.
 *
 * Two readers share one collection routine, so they can't drift on which
 * sources they cover or how they parse them:
 * - `readFolderKeys` picks the one key of each kind the app loads, for
 *   matching the folder against an account.
 * - `readAllFolderKeys` returns every key, for checks that must not let a
 *   write replace a key nobody compared.
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

/**
 * The SDK keyless file's state, as data so each caller decides what an
 * unusable file means: the claim check can't tell which app the folder runs
 * on, while `clerk link` has its own stop for a file with no usable claim link.
 * - `unreadable`: the file exists but couldn't be read or parsed (an SDK
 *   rewriting it, for example).
 * - `parsed`: it was read; either key may still be missing.
 */
export type SdkKeylessFile =
  | { state: "absent" }
  | { state: "unreadable" }
  | { state: "parsed"; publishableKey?: string; secretKey?: string };

/** A folder's keys, each from wherever the app would load it; absent when it holds none. */
export interface FolderKeys {
  publishableKey?: LocatedKey;
  secretKey?: LocatedKey;
  /** Set when the folder has no plain key, so the SDK keyless file is where keys would come from. */
  sdkFile?: SdkKeylessFile;
}

/** Every Clerk key a folder holds, wherever the app or `clerk env pull` could use it. */
export interface AllFolderKeys {
  publishableKeys: LocatedKey[];
  secretKeys: LocatedKey[];
  /** Set when the folder has no plain key, so the SDK keyless file is where keys would come from. */
  sdkFile?: SdkKeylessFile;
}

/**
 * The env files `findKeyInProject` and `readFolderKeys` consult, lowest
 * priority first. Milestone 4 of GROW-1249's plan replaces this with each
 * framework's documented load order.
 */
const ENV_FILES = [".env", ".env.local"];

/**
 * Every env file a key can sit in and still matter: one the app loads in
 * development, or one `clerk env pull` writes (it tries `.env.development.local`
 * first). Order is irrelevant here; every key in them is returned.
 */
const ALL_ENV_FILES = [".env", ".env.development", ".env.local", ".env.development.local"];

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

/** Reads the SDK's own keyless file and says what state it's in. Never throws. */
export async function readSdkKeylessFile(cwd: string): Promise<SdkKeylessFile> {
  const file = Bun.file(join(cwd, ...SDK_KEYLESS_FILE));
  try {
    if (!(await file.exists())) return { state: "absent" };
    const parsed: unknown = await file.json();
    if (typeof parsed !== "object" || parsed === null) return { state: "unreadable" };
    const { secretKey, publishableKey } = parsed as Record<string, unknown>;
    return {
      state: "parsed",
      secretKey: typeof secretKey === "string" && secretKey ? secretKey : undefined,
      publishableKey:
        typeof publishableKey === "string" && publishableKey ? publishableKey : undefined,
    };
  } catch {
    return { state: "unreadable" };
  }
}

/**
 * Reads the SDK's own keyless file, ignoring a partially-written one.
 * Exported for `init`, whose keep-the-existing-app guard must recognise an
 * application the SDK minted for itself just as readily as one `clerk init`
 * minted — the two files describe the same kind of unclaimed app.
 */
export async function readSdkKeylessApp(
  cwd: string,
): Promise<{ secretKey?: string; publishableKey?: string } | undefined> {
  const sdkFile = await readSdkKeylessFile(cwd);
  // A half-written file during an SDK refresh isn't worth failing over.
  if (sdkFile.state !== "parsed") return undefined;
  return { secretKey: sdkFile.secretKey, publishableKey: sdkFile.publishableKey };
}

interface CollectedKey extends LocatedKey {
  name: string;
  fromEnv: boolean;
}

/**
 * Every non-empty value under any of `names`: the environment first, in name
 * order, then each file in `files` in order, line by line. Callers choose from
 * this list; nothing here decides which key wins.
 */
async function collectKeys(cwd: string, names: string[], files: string[]): Promise<CollectedKey[]> {
  const collected: CollectedKey[] = [];
  for (const name of new Set(names)) {
    const value = process.env[name];
    if (value) collected.push({ name, value, source: `${name} env var`, fromEnv: true });
  }

  for (const envFile of files) {
    const file = Bun.file(join(cwd, envFile));
    if (!(await file.exists())) continue;

    for (const line of parseEnvFile(await file.text())) {
      if (line.type !== "entry" || !line.value) continue;
      if (names.includes(line.key)) {
        collected.push({ name: line.key, value: line.value, source: envFile, fromEnv: false });
      }
    }
  }
  return collected;
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
  const collected = await collectKeys(cwd, names, ENV_FILES);

  const fromEnv = collected.find((key) => key.fromEnv);
  if (fromEnv) return located(fromEnv);

  // Priority is by name, not by position: the framework-specific name beats
  // the generic fallback even when the generic one appears later in the same
  // file. Within one name, a later file still overrides an earlier one.
  for (const name of names) {
    const fromFiles = collected.filter((key) => key.name === name);
    const last = fromFiles.at(-1);
    if (last) return located(last);
  }
  return undefined;
}

function located({ value, source }: CollectedKey): LocatedKey {
  return { value, source };
}

async function keyNames(cwd: string): Promise<{ publishable: string[]; secret: string[] }> {
  const [publishableKeyName, secretKeyName] = await Promise.all([
    detectPublishableKeyName(cwd),
    detectSecretKeyName(cwd),
  ]);
  return {
    publishable: [publishableKeyName, "CLERK_PUBLISHABLE_KEY"],
    secret: [secretKeyName, "CLERK_SECRET_KEY"],
  };
}

/** The SDK keyless file's keys, labelled with their source. */
function sdkFileKeys(sdkFile: SdkKeylessFile): {
  publishableKey?: LocatedKey;
  secretKey?: LocatedKey;
} {
  if (sdkFile.state !== "parsed") return {};
  return {
    publishableKey: sdkFile.publishableKey
      ? { value: sdkFile.publishableKey, source: SDK_KEYLESS_SOURCE }
      : undefined,
    secretKey: sdkFile.secretKey
      ? { value: sdkFile.secretKey, source: SDK_KEYLESS_SOURCE }
      : undefined,
  };
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
 * a caller fail with a key-format error. An unusable SDK keyless file is
 * reported in `sdkFile`, not thrown. A filesystem error reading an env file
 * propagates: callers must not mistake "couldn't read" for "no keys".
 */
export async function readFolderKeys(cwd: string): Promise<FolderKeys> {
  const names = await keyNames(cwd);
  const [publishableKey, secretKey] = await Promise.all([
    findKeyInProject(cwd, names.publishable),
    findKeyInProject(cwd, names.secret),
  ]);
  if (publishableKey || secretKey) return { publishableKey, secretKey };

  const sdkFile = await readSdkKeylessFile(cwd);
  return { ...sdkFileKeys(sdkFile), sdkFile };
}

/**
 * Every Clerk key the folder holds, from the environment and every env file
 * the app or `clerk env pull` could use, each with its source.
 *
 * For a check that decides whether writing keys is safe: which key the app
 * loads depends on the framework, and `env pull` picks its own file, so the
 * only safe question is whether every key there belongs to the same app. The
 * SDK keyless file follows the same rule as in `readFolderKeys`: it counts only
 * when the folder has no plain key. Errors behave as in `readFolderKeys`.
 */
export async function readAllFolderKeys(cwd: string): Promise<AllFolderKeys> {
  const names = await keyNames(cwd);
  const [publishable, secret] = await Promise.all([
    collectKeys(cwd, names.publishable, ALL_ENV_FILES),
    collectKeys(cwd, names.secret, ALL_ENV_FILES),
  ]);
  if (publishable.length > 0 || secret.length > 0) {
    return { publishableKeys: publishable.map(located), secretKeys: secret.map(located) };
  }

  const sdkFile = await readSdkKeylessFile(cwd);
  const { publishableKey, secretKey } = sdkFileKeys(sdkFile);
  return {
    publishableKeys: publishableKey ? [publishableKey] : [],
    secretKeys: secretKey ? [secretKey] : [],
    sdkFile,
  };
}
