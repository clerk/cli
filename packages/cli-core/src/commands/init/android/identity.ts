import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, ERROR_CODE, EXIT_CODE, errorMessage } from "../../../lib/errors.ts";
import { log } from "../../../lib/log.ts";
import { setupError, NATIVE_APPLICATIONS_DASHBOARD } from "./types.ts";

/** Uppercase, colon-separated SHA-256 fingerprints, deduplicated and sorted. */
export function normalizeFingerprints(values: readonly string[]): string[] {
  return [
    ...new Set(
      values.map((value) => {
        const compact = value
          .trim()
          .replace(/^SHA-?256:\s*/i, "")
          .replaceAll(":", "");
        if (!/^[a-fA-F0-9]{64}$/.test(compact))
          throw setupError(
            `"${value.trim()}" is not a SHA-256 signing certificate fingerprint (64 hex digits, optionally colon-separated).`,
          );
        return compact.toUpperCase().match(/../g)!.join(":");
      }),
    ),
  ].sort();
}

export interface DebugKeystore {
  status: "found" | "no-keystore" | "no-keytool" | "failed";
  fingerprint?: string;
  keystore: string;
  keytool?: string;
  detail?: string;
}
export type DebugKeystoreReader = (signal?: AbortSignal) => Promise<DebugKeystore>;

/** Where Android Studio and Gradle keep the per-machine debug signing certificate. */
export function debugKeystorePath(env: NodeJS.ProcessEnv = process.env): string {
  const home =
    env.ANDROID_USER_HOME ||
    (env.ANDROID_SDK_HOME ? join(env.ANDROID_SDK_HOME, ".android") : join(homedir(), ".android"));
  return join(home, "debug.keystore");
}

/** Where `keytool` can be, in order: PATH, JAVA_HOME, then the JDK Android Studio bundles. */
export function keytoolCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const windows = platform === "win32";
  const exe = windows ? "keytool.exe" : "keytool";
  const candidates = [
    Bun.which("keytool") ?? undefined,
    env.JAVA_HOME && join(env.JAVA_HOME, "bin", exe),
    ...(windows
      ? [
          env.ProgramFiles &&
            join(env.ProgramFiles, "Android", "Android Studio", "jbr", "bin", exe),
          env["ProgramFiles(x86)"] &&
            join(env["ProgramFiles(x86)"], "Android", "Android Studio", "jbr", "bin", exe),
          env.LOCALAPPDATA &&
            join(env.LOCALAPPDATA, "Programs", "Android Studio", "jbr", "bin", exe),
        ]
      : [
          "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool",
          join(homedir(), "Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool"),
          "/opt/android-studio/jbr/bin/keytool",
          join(homedir(), "android-studio/jbr/bin/keytool"),
        ]),
  ];
  return candidates.filter((candidate): candidate is string => !!candidate);
}

/** `keytool` from PATH, JAVA_HOME, or the JDK Android Studio bundles. */
export async function findKeytool(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  for (const candidate of keytoolCandidates(env))
    if (await Bun.file(candidate).exists()) return candidate;
  return undefined;
}

/** The SHA-256 fingerprint of the debug certificate, read with `keytool`. Never throws. */
export const readDebugKeystore: DebugKeystoreReader = async (signal) => {
  const keystore = debugKeystorePath();
  if (!(await Bun.file(keystore).exists())) return { status: "no-keystore", keystore };
  const keytool = await findKeytool();
  if (!keytool) return { status: "no-keytool", keystore };
  try {
    const child = Bun.spawn(
      [
        keytool,
        "-list",
        "-v",
        "-keystore",
        keystore,
        "-alias",
        "androiddebugkey",
        "-storepass",
        "android",
        "-keypass",
        "android",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000, signal },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    log.debug(`android: ${keytool} -list exited ${code} for ${keystore}`);
    const match = /SHA256:\s*([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){31})/.exec(stdout);
    if (code !== 0 || !match)
      return {
        status: "failed",
        keystore,
        keytool,
        detail: (stderr || stdout).trim().split("\n").slice(-3).join(" "),
      };
    return { status: "found", keystore, keytool, fingerprint: match[1]!.toUpperCase() };
  } catch (error) {
    signal?.throwIfAborted();
    return { status: "failed", keystore, keytool, detail: errorMessage(error) };
  }
};

export interface IdentityDiscovery {
  applicationId: string;
  applicationIdSource: "gradle" | "gradle-debug" | "explicit";
  fingerprints: string[];
  /** Fingerprints passed with --android-fingerprint. */
  explicit: string[];
  debug: DebugKeystore;
  issues: string[];
}

/** Why the debug keystore gave no fingerprint, and what to do about it. */
export function debugKeystoreNote(debug: DebugKeystore): string | undefined {
  switch (debug.status) {
    case "found":
      return undefined;
    case "no-keystore":
      return `No debug keystore at ${debug.keystore}: build the app once (Android Studio or ./gradlew assembleDebug creates it), or pass --android-fingerprint <SHA-256> from ./gradlew signingReport.`;
    case "no-keytool":
      return `keytool was not found on PATH, in JAVA_HOME, or in Android Studio's bundled JDK, so the debug certificate at ${debug.keystore} could not be read. Install a JDK, or pass --android-fingerprint <SHA-256> from ./gradlew signingReport.`;
    case "failed":
      return `keytool could not read ${debug.keystore}${debug.detail ? ` (${debug.detail})` : ""}. Pass --android-fingerprint <SHA-256> from ./gradlew signingReport.`;
  }
}

export async function discoverIdentity(
  selection: {
    applicationId: string;
    applicationIdSource: IdentityDiscovery["applicationIdSource"];
  },
  explicitFingerprints: readonly string[] | undefined,
  readKeystore: DebugKeystoreReader | false,
  signal?: AbortSignal,
): Promise<IdentityDiscovery> {
  const explicit = normalizeFingerprints(explicitFingerprints ?? []);
  const debug: DebugKeystore = readKeystore
    ? await readKeystore(signal)
    : { status: "no-keystore", keystore: debugKeystorePath() };
  const fingerprints = normalizeFingerprints([
    ...explicit,
    ...(debug.fingerprint ? [debug.fingerprint] : []),
  ]);
  const issues: string[] = [];
  const note = debugKeystoreNote(debug);
  if (note && readKeystore) issues.push(note);
  return {
    applicationId: selection.applicationId,
    applicationIdSource: selection.applicationIdSource,
    fingerprints,
    explicit,
    debug,
    issues,
  };
}

export function describeIdentity(identity: IdentityDiscovery) {
  return {
    applicationId: identity.applicationId,
    applicationIdSource: identity.applicationIdSource,
    fingerprints: identity.fingerprints,
    fingerprintSources: {
      explicit: identity.explicit,
      debugKeystore: identity.debug.status,
    },
    issues: identity.issues,
  };
}

/** Setup can't register the app without a signing certificate fingerprint; say how to supply one. */
export class IdentityRequired extends CliError {
  constructor(public identity: IdentityDiscovery) {
    super(
      [
        `No signing certificate fingerprint is known for ${identity.applicationId}, and Clerk serves assetlinks.json for passkeys from the registered fingerprints.`,
        ...identity.issues,
      ].join(" "),
      { code: ERROR_CODE.USAGE_ERROR, exitCode: EXIT_CODE.USAGE },
    );
  }
}

/** The message for a registration that exists without this machine's fingerprint. */
export function missingFingerprintsMessage(
  packageName: string,
  missing: string[],
  registered: string[],
): string {
  return `Clerk already registers ${packageName} with ${registered.length ? registered.join(", ") : "no fingerprints"}, but not ${missing.join(", ")}. The Platform API can't update a registration yet: add the fingerprint${missing.length === 1 ? "" : "s"} on the Native Applications page (${NATIVE_APPLICATIONS_DASHBOARD}), then rerun clerk init.`;
}
