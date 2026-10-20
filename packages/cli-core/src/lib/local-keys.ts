/**
 * The Clerk keys a folder holds, read from the folder alone.
 *
 * Two readers share one line reader, so they can't drift on how they parse a
 * file or what counts as a Clerk line:
 * - `readFolderKeys` picks the one key of each kind the app loads, for
 *   matching the folder against an account.
 * - `readAllFolderKeys` returns every key, under every name a Clerk SDK reads,
 *   for checks that must not let a write replace a key nobody compared.
 *
 * A leaf module on purpose: it must not import `lib/config.ts`, directly or
 * through `lib/keyless-target.ts`, because `lib/config.ts` will need it to word
 * its not-linked errors. `lib/keyless-target.ts` re-exports the helpers that
 * used to live there, so their importers are unchanged.
 */

import { join } from "node:path";
import { ENV_FILE_CANDIDATES, parseEnvFile } from "./dotenv.ts";
import { CLERK_KEY_NAMES, detectFramework } from "./framework.ts";

export interface LocatedKey {
  value: string;
  /** The variable the key is stored under. */
  name: string;
  /** Where the key came from, for display (`CLERK_SECRET_KEY env var`, `.env.local`). */
  source: string;
}

/**
 * A line that names a Clerk key but that the CLI's env parser can't read:
 * indented, spaced around `=`, or `KEY: value`. Frameworks load env files with
 * parsers that accept these, so the key is real but its value is unknown.
 */
export interface UnreadableKeyLine {
  kind: "publishable" | "secret";
  name: string;
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
  /**
   * Clerk lines in the files read that couldn't be parsed; present only when
   * there are some. Either key may then be one the app doesn't load.
   */
  unreadableLines?: UnreadableKeyLine[];
  /**
   * Keys the CLI can't choose between: the folder's framework documents no
   * env file order (or none was detected), and its files hold different
   * values. That kind's key is then absent, never guessed. Present only when
   * there are some.
   */
  undecided?: { publishable?: LocatedKey[]; secret?: LocatedKey[] };
  /** Set when the folder has no plain key, so the SDK keyless file is where keys would come from. */
  sdkFile?: SdkKeylessFile;
}

/** Every Clerk key a folder holds, wherever the app or `clerk env pull` could use it. */
export interface AllFolderKeys {
  publishableKeys: LocatedKey[];
  secretKeys: LocatedKey[];
  /** Clerk lines that couldn't be parsed; present only when there are some. */
  unreadableLines?: UnreadableKeyLine[];
  /** Set when the folder has no plain key, so the SDK keyless file is where keys would come from. */
  sdkFile?: SdkKeylessFile;
}

/**
 * The env files `findKeyInProject` consults, highest priority first: the order
 * the CLI used before `readFolderKeys` followed each framework's own.
 * Milestone 10 of GROW-1249's plan moves its callers onto `readFolderKeys`.
 */
const LEGACY_LOAD_ORDER = [".env.local", ".env"];

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

interface KeyNames {
  publishable: readonly string[];
  secret: readonly string[];
}

interface FileKey extends LocatedKey {
  kind: "publishable" | "secret";
}

/**
 * Every non-empty key under `names` in `files`, in file order then line order,
 * plus every line that names one of them but can't be parsed. A real comment
 * (`# CLERK_SECRET_KEY=…`) doesn't count: env loaders skip those too.
 */
async function readKeyLines(
  cwd: string,
  files: readonly string[],
  names: KeyNames,
): Promise<{ keys: FileKey[]; unreadable: UnreadableKeyLine[] }> {
  const keys: FileKey[] = [];
  const unreadable: UnreadableKeyLine[] = [];
  const kindOf = (name: string) =>
    names.publishable.includes(name)
      ? ("publishable" as const)
      : names.secret.includes(name)
        ? ("secret" as const)
        : undefined;

  for (const envFile of files) {
    const file = Bun.file(join(cwd, envFile));
    if (!(await file.exists())) continue;

    for (const line of parseEnvFile(await file.text())) {
      if (line.type === "entry") {
        const kind = kindOf(line.key);
        if (kind && line.value) {
          keys.push({ kind, name: line.key, value: line.value, source: envFile });
        }
        continue;
      }
      if (line.type !== "comment" || line.raw.trim().startsWith("#")) continue;
      const named = namedIn(line.raw, names);
      if (named) unreadable.push({ ...named, source: envFile });
    }
  }
  return { keys, unreadable };
}

/** The Clerk key name a line mentions as a whole word, if any; the longest wins. */
function namedIn(
  raw: string,
  names: KeyNames,
): { kind: "publishable" | "secret"; name: string } | undefined {
  const mentions = (name: string) =>
    new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(raw);
  const candidates = [
    ...names.publishable.map((name) => ({ kind: "publishable" as const, name })),
    ...names.secret.map((name) => ({ kind: "secret" as const, name })),
  ].sort((a, b) => b.name.length - a.name.length);
  return candidates.find(({ name }) => mentions(name));
}

function fromEnv(name: string): LocatedKey | undefined {
  const value = process.env[name];
  return value ? { value, name, source: `${name} env var` } : undefined;
}

interface EffectiveKey {
  key?: LocatedKey;
  /** The files' different values for the winning name, when no load order picks one. */
  undecided?: LocatedKey[];
  unreadable: UnreadableKeyLine[];
}

/**
 * The key under any of `names` the app loads, and any unreadable lines among
 * the files it would have come from. An exported key wins and returns before
 * any file is read, so an unreadable env file can't break a caller that only
 * needs the exported key.
 *
 * `loadOrder` lists the files the app loads, highest priority first. Without
 * one, every candidate file is read, and files holding different values leave
 * the key undecided: picking one would be a guess about which the app loads.
 */
async function effectiveKey(
  cwd: string,
  kind: "publishable" | "secret",
  names: string[],
  loadOrder: readonly string[] | undefined,
): Promise<EffectiveKey> {
  for (const name of new Set(names)) {
    const key = fromEnv(name);
    if (key) return { key, unreadable: [] };
  }

  const { keys, unreadable } = await readKeyLines(cwd, loadOrder ?? ENV_FILE_CANDIDATES, {
    publishable: kind === "publishable" ? names : [],
    secret: kind === "secret" ? names : [],
  });
  // Priority is by name, not by position: the framework-specific name beats
  // the generic fallback even when the generic one is in a higher-priority
  // file. Within one name, each file's last line is its value, and the file
  // highest in the load order wins.
  for (const name of names) {
    const perFile = new Map<string, LocatedKey>();
    for (const { value, source } of keys.filter((key) => key.name === name)) {
      perFile.set(source, { value, name, source });
    }
    const values = [...perFile.values()];
    if (values.length === 0) continue;
    if (!loadOrder && new Set(values.map((key) => key.value)).size > 1) {
      return { undecided: values, unreadable };
    }
    return { key: values[0], unreadable };
  }
  return { unreadable };
}

/**
 * Looks for a key under any of `names`, in the order the app itself would
 * resolve one: the environment first, then `.env.local` over `.env`.
 */
export async function findKeyInProject(
  cwd: string,
  names: string[],
): Promise<LocatedKey | undefined> {
  // The kind only labels unreadable lines, which this caller doesn't use.
  return (await effectiveKey(cwd, "publishable", names, LEGACY_LOAD_ORDER)).key;
}

/** The SDK keyless file's keys, labelled with their source. */
function sdkFileKeys(sdkFile: SdkKeylessFile): {
  publishableKey?: LocatedKey;
  secretKey?: LocatedKey;
} {
  if (sdkFile.state !== "parsed") return {};
  return {
    publishableKey: sdkFile.publishableKey
      ? { value: sdkFile.publishableKey, name: "publishableKey", source: SDK_KEYLESS_SOURCE }
      : undefined,
    secretKey: sdkFile.secretKey
      ? { value: sdkFile.secretKey, name: "secretKey", source: SDK_KEYLESS_SOURCE }
      : undefined,
  };
}

/**
 * The publishable and secret key the folder's app loads, each with its source.
 *
 * Plain keys come in the order the app resolves them: an exported variable,
 * then the detected framework's env files in its documented load order
 * (`envLoadOrder`). For a framework without one, or none detected, all four
 * candidate files are read, and files that disagree leave that key
 * `undecided`. The SDK's keyless file counts only when the folder has no
 * plain key of either kind, and then both keys come from it: the SDK writes
 * that file only when nothing else configures Clerk, so a plain key means the
 * app runs on the plain keys, and pairing one with the SDK file's other key
 * would describe two different apps as one. A Clerk line that can't be parsed,
 * and an undecided key, count as plain keys for that rule; the line is
 * reported in `unreadableLines`.
 *
 * Keys are returned as found, never validated, so a malformed key can't make
 * a caller fail with a key-format error. An unusable SDK keyless file is
 * reported in `sdkFile`, not thrown. A filesystem error reading an env file
 * propagates: callers must not mistake "couldn't read" for "no keys".
 */
export async function readFolderKeys(cwd: string): Promise<FolderKeys> {
  const framework = await detectFramework(cwd);
  const loadOrder = framework?.envLoadOrder;
  const [publishable, secret] = await Promise.all([
    effectiveKey(
      cwd,
      "publishable",
      [framework?.envVar ?? "CLERK_PUBLISHABLE_KEY", "CLERK_PUBLISHABLE_KEY"],
      loadOrder,
    ),
    effectiveKey(
      cwd,
      "secret",
      [framework?.secretKeyEnvVar ?? "CLERK_SECRET_KEY", "CLERK_SECRET_KEY"],
      loadOrder,
    ),
  ]);
  const unreadableLines = [...publishable.unreadable, ...secret.unreadable];
  const undecided =
    publishable.undecided || secret.undecided
      ? {
          ...(publishable.undecided && { publishable: publishable.undecided }),
          ...(secret.undecided && { secret: secret.undecided }),
        }
      : undefined;
  const plain = {
    publishableKey: publishable.key,
    secretKey: secret.key,
    ...(unreadableLines.length > 0 && { unreadableLines }),
    ...(undecided && { undecided }),
  };
  if (publishable.key || secret.key || unreadableLines.length > 0 || undecided) return plain;

  const sdkFile = await readSdkKeylessFile(cwd);
  return { ...sdkFileKeys(sdkFile), sdkFile };
}

/**
 * Every Clerk key the folder holds, from the environment and every env file
 * the app or `clerk env pull` could use, under every name a supported Clerk
 * SDK reads (`CLERK_KEY_NAMES`), each with its source. Lines naming a Clerk key
 * that can't be parsed are reported in `unreadableLines`.
 *
 * For a check that decides whether writing keys is safe: which key the app
 * loads depends on the framework, and `clerk env pull` picks its own file, so
 * the only safe question is whether every key there belongs to the same app.
 * The SDK keyless file follows the same rule as in `readFolderKeys`. Errors
 * behave as in `readFolderKeys`.
 */
export async function readAllFolderKeys(cwd: string): Promise<AllFolderKeys> {
  const fromShell = (kind: "publishable" | "secret") =>
    CLERK_KEY_NAMES[kind].flatMap((name) => {
      const key = fromEnv(name);
      return key ? [key] : [];
    });
  const { keys, unreadable } = await readKeyLines(cwd, ENV_FILE_CANDIDATES, CLERK_KEY_NAMES);
  const ofKind = (kind: "publishable" | "secret") => [
    ...fromShell(kind),
    ...keys
      .filter((key) => key.kind === kind)
      .map(({ value, name, source }) => ({ value, name, source })),
  ];
  const publishableKeys = ofKind("publishable");
  const secretKeys = ofKind("secret");
  if (publishableKeys.length > 0 || secretKeys.length > 0 || unreadable.length > 0) {
    return {
      publishableKeys,
      secretKeys,
      ...(unreadable.length > 0 && { unreadableLines: unreadable }),
    };
  }

  const sdkFile = await readSdkKeylessFile(cwd);
  const { publishableKey, secretKey } = sdkFileKeys(sdkFile);
  return {
    publishableKeys: publishableKey ? [publishableKey] : [],
    secretKeys: secretKey ? [secretKey] : [],
    sdkFile,
  };
}
