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
 * through `lib/keyless-target.ts`, because `lib/config.ts` reaches it, through
 * the unlinked-folder module, to word its not-linked errors.
 */

import { join } from "node:path";
import { ENV_FILE_CANDIDATES, parseEnvFile } from "./dotenv.ts";
import { errorMessage } from "./errors.ts";
import { log } from "./log.ts";
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

/**
 * A read of the folder's keys (`readFolderKeys`) a caller already made, or why
 * it failed, as a clause. Passed on so one run decides from one read: a
 * second read could combine facts from different moments, e.g. after
 * `next dev` writes the SDK keyless file.
 */
export type FolderRead = FolderKeys | { readError: string };

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

/** How an exported variable is named as a key's source: `NUXT_CLERK_SECRET_KEY env var`. */
export const ENV_VAR_SOURCE_SUFFIX = " env var";

/** "`CLERK_SECRET_KEY` in .env.local", or "the `CLERK_SECRET_KEY` env var". Never the value. */
export function describeKeyLocation({ name, source }: { name: string; source: string }): string {
  return source === `${name}${ENV_VAR_SOURCE_SUFFIX}`
    ? `the \`${name}\` env var`
    : `\`${name}\` in ${source}`;
}

/** The current Clerk key formats, `pk_`/`sk_`. */
const KEY_SHAPE = /^(?:pk|sk)_(?:test|live)_[A-Za-z0-9+/=_-]+$/;
/** The legacy `test_`/`live_` key format. */
const LEGACY_KEY_SHAPE = /^(?:test|live)_[A-Za-z0-9+/=_-]+$/;

/**
 * Whether a value is shaped like a Clerk key in the current formats. Anything
 * else (a value with a trailing `# comment` the CLI's parser kept, a `${VAR}`
 * reference, a placeholder) needs interpretation the CLI doesn't do. Shared
 * by the claim check's key comparison and `clerk link`, so both mean the same
 * thing by "a key".
 */
export function isClerkKeyShaped(value: string): boolean {
  return KEY_SHAPE.test(value);
}

/**
 * Whether a folder value could be one of an app's keys: shaped like a Clerk
 * key, or a legacy key, which the claim check still matches when it's
 * identical to one of the app's.
 */
export function mayBeAnAppsKey(value: string): boolean {
  return isClerkKeyShaped(value) || LEGACY_KEY_SHAPE.test(value);
}

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
 * Whether the SDK keyless file holds a claim link the CLI may open, and if
 * not, why, as a clause for a message. Never the URL in that reason: it
 * carries a credential-equivalent token.
 */
export type SdkClaimLink =
  | { status: "usable"; url: string }
  | { status: "unusable"; reason: string };

/**
 * The claim link the SDK wrote for the app it created, already pointed at the
 * right Dashboard host. The file is written by another process, so its
 * contents are untrusted: anything but well-formed https is refused rather
 * than handed to the browser launcher, which on Windows goes through
 * `cmd /c start "" "<url>"`, where a `file:`/`javascript:` scheme or an
 * embedded quote stops being just a URL. Never throws, and never logs the URL.
 */
export async function readSdkClaimLink(cwd: string): Promise<SdkClaimLink> {
  const file = Bun.file(join(cwd, ...SDK_KEYLESS_FILE));
  let parsed: unknown;
  try {
    if (!(await file.exists())) return { status: "unusable", reason: "it doesn't exist" };
    parsed = await file.json();
  } catch {
    // A half-written file during an SDK refresh isn't worth failing over.
    return { status: "unusable", reason: "it can't be read" };
  }
  const claimUrl =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { claimUrl?: unknown }).claimUrl
      : undefined;
  if (typeof claimUrl !== "string" || !claimUrl) {
    return { status: "unusable", reason: "it has no claim URL" };
  }
  let isHttps = false;
  try {
    isHttps = new URL(claimUrl).protocol === "https:";
  } catch {
    // fall through: not a URL at all
  }
  if (!isHttps) {
    log.debug(`keyless: ignoring non-https claimUrl in ${SDK_KEYLESS_SOURCE}`);
    return { status: "unusable", reason: "its claim URL isn't an https link" };
  }
  return { status: "usable", url: claimUrl };
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
  return value ? { value, name, source: `${name}${ENV_VAR_SOURCE_SUFFIX}` } : undefined;
}

interface EffectiveKey {
  key?: LocatedKey;
  /** The files' different values for the winning name, when no load order picks one. */
  undecided?: LocatedKey[];
  unreadable: UnreadableKeyLine[];
}

/**
 * The key under any of `names` the app loads, from the shell and from `lines`,
 * this kind's keys and unreadable lines in the files the app would load it from.
 *
 * Priority is by name, then source: the first name found anywhere wins, so
 * the framework's own name in a file beats a generic name exported in the
 * shell. Within one name, the shell beats the files.
 *
 * `loadOrder` lists the files the app loads, highest priority first. Without
 * one, every candidate file is read, and files holding different values leave
 * the key undecided: picking one would be a guess about which the app loads.
 */
function effectiveKey(
  names: readonly string[],
  lines: { keys: FileKey[]; unreadable: UnreadableKeyLine[] },
  loadOrder: readonly string[] | undefined,
): EffectiveKey {
  const { keys, unreadable } = lines;
  // Within one name, each file's last line is its value, and the file highest
  // in the load order wins.
  for (const name of names) {
    const exported = fromEnv(name);
    if (exported) return { key: exported, unreadable };
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
  const names = {
    publishable: [...new Set(keyNames(framework, "publishable"))],
    secret: [...new Set(keyNames(framework, "secret"))],
  };
  // A key exported under the first name the app reads needs no file, so an
  // unreadable env file can't break a caller when both keys are exported.
  const exported = {
    publishable: names.publishable[0] ? fromEnv(names.publishable[0]) : undefined,
    secret: names.secret[0] ? fromEnv(names.secret[0]) : undefined,
  };
  const lines =
    exported.publishable && exported.secret
      ? { keys: [], unreadable: [] }
      : await readKeyLines(cwd, loadOrder ?? ENV_FILE_CANDIDATES, {
          publishable: exported.publishable ? [] : names.publishable,
          secret: exported.secret ? [] : names.secret,
        });
  const ofKind = (kind: "publishable" | "secret"): EffectiveKey => {
    const first = exported[kind];
    if (first) return { key: first, unreadable: [] };
    return effectiveKey(
      names[kind],
      {
        keys: lines.keys.filter((key) => key.kind === kind),
        unreadable: lines.unreadable.filter((line) => line.kind === kind),
      },
      loadOrder,
    );
  };
  const publishable = ofKind("publishable");
  const secret = ofKind("secret");
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

/** The names the folder's app reads a key under, its framework's own first. */
function keyNames(
  framework: Awaited<ReturnType<typeof detectFramework>>,
  kind: "publishable" | "secret",
): string[] {
  if (kind === "secret")
    return [framework?.secretKeyEnvVar ?? "CLERK_SECRET_KEY", "CLERK_SECRET_KEY"];
  // Only the names the framework's SDK reads: a generic key isn't one a
  // Next.js, Astro, Nuxt, or Vue app loads.
  return framework?.readsGenericPublishableKey === false
    ? [framework.envVar]
    : [framework?.envVar ?? "CLERK_PUBLISHABLE_KEY", "CLERK_PUBLISHABLE_KEY"];
}

/**
 * A generic `CLERK_PUBLISHABLE_KEY` line in the files the folder's app loads,
 * when its framework's SDK reads only its own name (Next.js, say), and that
 * framework's name. The first such line in load order; never its value.
 */
export async function unreadGenericPublishableKey(
  cwd: string,
): Promise<{ location: { name: string; source: string }; framework: string } | undefined> {
  const framework = await detectFramework(cwd);
  if (framework?.readsGenericPublishableKey !== false) return undefined;
  const { keys } = await readKeyLines(cwd, framework.envLoadOrder ?? ENV_FILE_CANDIDATES, {
    publishable: ["CLERK_PUBLISHABLE_KEY"],
    secret: [],
  });
  const [first] = keys;
  return (
    first && { location: { name: first.name, source: first.source }, framework: framework.name }
  );
}

/**
 * The key `readFolderKeys` returns before reading any file: one exported in
 * the shell under the first name the app reads. For a caller that must work
 * when an env file it doesn't need can't be read.
 */
export async function exportedFolderKey(
  cwd: string,
  kind: "publishable" | "secret",
): Promise<LocatedKey | undefined> {
  const [first] = keyNames(await detectFramework(cwd), kind);
  return first ? fromEnv(first) : undefined;
}

/**
 * Whether the folder's only Clerk keys are the ones a Clerk SDK wrote for an
 * app it created itself. The SDK writes its keyless file only when nothing
 * else configures Clerk, so the folder is SDK-only when it holds no plain key,
 * no Clerk line the CLI can't read, and no undecided key, and the SDK file
 * exists. Shared by `clerk link` and the unlinked-folder advice, so the two
 * never judge a folder differently.
 */
export function isSdkOnly(keys: FolderKeys): boolean {
  return Boolean(keys.sdkFile) && keys.sdkFile?.state !== "absent";
}

/**
 * Why an SDK-only folder's keyless file gives no publishable key to find or
 * claim its app by, as a clause. For a folder whose SDK file holds none.
 */
export function sdkFileWithoutKeyReason(sdkFile: SdkKeylessFile | undefined): string {
  return sdkFile?.state === "unreadable" ? "it can't be read" : "it has no publishable key";
}

/**
 * Says the SDK keyless file has no usable claim link, and why. Shared by
 * `clerk link`'s stop and the unlinked-folder advice, so the two say the same.
 */
export function noUsableClaimLinkSentence(why: string): string {
  return `This folder's Clerk SDK keyless file (\`${SDK_KEYLESS_SOURCE}\`) has no usable claim link: ${why}.`;
}

/** What to do when no claim link and no key match leads to the folder's app. */
export const LINK_EXISTING_APP_SENTENCE =
  "Link an existing application with `clerk link --app <app_id>`.";

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

/**
 * Whether `file` names a Clerk key on any line, under any name a Clerk SDK
 * reads: with a value, with an empty one, or on a line the CLI can't parse
 * (listed). `unreadable` when the file exists but can't be read. For `env
 * pull`, which mustn't write below a file that may still set a key.
 */
export async function clerkLinesIn(
  cwd: string,
  file: string,
): Promise<{ any: boolean; unreadableLines: UnreadableKeyLine[] } | "unreadable"> {
  const handle = Bun.file(join(cwd, file));
  if (!(await handle.exists())) return { any: false, unreadableLines: [] };
  let text: string;
  try {
    text = await handle.text();
  } catch (error) {
    log.debug(`local-keys: couldn't read ${file} — ${errorMessage(error)}`);
    return "unreadable";
  }
  const names = new Set([...CLERK_KEY_NAMES.publishable, ...CLERK_KEY_NAMES.secret]);
  const unreadableLines: UnreadableKeyLine[] = [];
  let any = false;
  for (const line of parseEnvFile(text)) {
    if (line.type === "entry") {
      if (names.has(line.key)) any = true;
      continue;
    }
    if (line.type !== "comment" || line.raw.trim().startsWith("#")) continue;
    const named = namedIn(line.raw, CLERK_KEY_NAMES);
    if (named) unreadableLines.push({ ...named, source: file });
  }
  return { any: any || unreadableLines.length > 0, unreadableLines };
}

/** Why the folder's env files couldn't be read, as a clause; never a key. */
export function unreadableFolderReason(error: unknown): string {
  return `the CLI couldn't read this folder's env files (${errorMessage(error)})`;
}

/**
 * Why the CLI can't tell which publishable key the folder's app loads, as a
 * clause; undefined when it can.
 */
export function couldntTellReason({ unreadableLines, undecided }: FolderKeys): string | undefined {
  const line = unreadableLines?.[0];
  if (line) {
    return `the CLI couldn't read the \`${line.name}\` line in \`${line.source}\`, so it can't tell which key this app loads`;
  }
  const conflicting = undecided?.publishable;
  if (conflicting) {
    return `${listInProse(conflicting.map((key) => `\`${key.source}\``))} hold different Clerk publishable keys, and the CLI doesn't know which one this app loads`;
  }
  return undefined;
}

/** Why the folder's secret keys are undecided, as a clause; undefined when they aren't. */
export function secretKeysDisagreeReason({ undecided }: FolderKeys): string | undefined {
  const conflicting = undecided?.secret;
  if (!conflicting) return undefined;
  return `${listInProse(conflicting.map((key) => `\`${key.source}\``))} hold different Clerk secret keys, and the CLI doesn't know which one this app loads`;
}

function listInProse(items: string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}
