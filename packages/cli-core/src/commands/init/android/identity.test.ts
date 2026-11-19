import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  debugKeystoreNote,
  debugKeystorePath,
  debugKeystoreReader,
  discoverIdentity,
  keytoolCandidates,
  missingFingerprintsMessage,
  normalizeFingerprints,
} from "./identity.ts";
import { DEBUG_FINGERPRINT, RELEASE_FINGERPRINT, keystore } from "./test-helpers.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("fingerprints", () => {
  test("normalizes to uppercase colon-separated SHA-256 and dedupes", () => {
    expect(
      normalizeFingerprints(["ab".repeat(32), DEBUG_FINGERPRINT, `SHA256: ${"ab".repeat(32)}`]),
    ).toEqual([DEBUG_FINGERPRINT]);
    expect(normalizeFingerprints([RELEASE_FINGERPRINT, DEBUG_FINGERPRINT])).toEqual([
      DEBUG_FINGERPRINT,
      RELEASE_FINGERPRINT,
    ]);
    expect(() => normalizeFingerprints(["ab".repeat(20)])).toThrow("SHA-256");
  });

  test("the debug keystore follows Android's user home variables", () => {
    expect(debugKeystorePath({ HOME: "/h" })).toEndWith("/.android/debug.keystore");
    expect(debugKeystorePath({ ANDROID_USER_HOME: "/custom" })).toBe("/custom/debug.keystore");
    expect(debugKeystorePath({ ANDROID_SDK_HOME: "/legacy" })).toBe(
      "/legacy/.android/debug.keystore",
    );
  });

  test("combines the debug certificate with explicit fingerprints", async () => {
    const identity = await discoverIdentity(
      { applicationId: "com.example.app", applicationIdSource: "gradle" },
      [RELEASE_FINGERPRINT],
      keystore("found"),
    );
    expect(identity.fingerprints).toEqual([DEBUG_FINGERPRINT, RELEASE_FINGERPRINT]);
    expect(identity.explicit).toEqual([RELEASE_FINGERPRINT]);
    expect(identity.issues).toEqual([]);
  });

  const UNREADABLE = ["no-keystore", "no-keytool", "failed"] as const;
  test.each([...UNREADABLE])(
    "says what to do when the debug certificate can't be read (%s)",
    async (status) => {
      const identity = await discoverIdentity(
        { applicationId: "com.example.app", applicationIdSource: "gradle" },
        undefined,
        keystore(status),
      );
      expect(identity.fingerprints).toEqual([]);
      expect(identity.issues[0]).toContain("--android-fingerprint");
      expect(debugKeystoreNote(identity.debug)).toBe(identity.issues[0]);
    },
  );

  test("an explicit fingerprint makes an unread keystore no issue", async () => {
    const identity = await discoverIdentity(
      { applicationId: "com.example.app", applicationIdSource: "gradle" },
      [RELEASE_FINGERPRINT],
      keystore("no-keytool"),
    );
    expect(identity.fingerprints).toEqual([RELEASE_FINGERPRINT]);
    expect(identity.debug.status).toBe("no-keytool");
    expect(identity.issues).toEqual([]);
  });

  test("a debug build type with its own signing config leaves the keystore unread", async () => {
    let read = false;
    const identity = await discoverIdentity(
      { applicationId: "com.example.app", applicationIdSource: "gradle", debugSigning: "custom" },
      undefined,
      async () => {
        read = true;
        return keystore("found")();
      },
    );
    expect(read).toBe(false);
    expect(identity.debug.status).toBe("custom-signing");
    expect(identity.fingerprints).toEqual([]);
    expect(identity.issues[0]).toContain("signing config");
    expect(identity.issues[0]).toContain("--android-fingerprint");
    const explicit = await discoverIdentity(
      { applicationId: "com.example.app", applicationIdSource: "gradle", debugSigning: "custom" },
      [RELEASE_FINGERPRINT],
      keystore("found"),
    );
    expect(explicit.fingerprints).toEqual([RELEASE_FINGERPRINT]);
    expect(explicit.issues).toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "tries every keytool on disk until one reads the keystore",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "clerk-keytool-"));
      roots.push(dir);
      const script = async (path: string, body: string) => {
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      };
      await mkdir(join(dir, "home"), { recursive: true });
      await writeFile(join(dir, "home", "debug.keystore"), "");
      // macOS's /usr/bin/keytool stub: present, first on PATH, and unable to run.
      await script(
        join(dir, "stub", "keytool"),
        "echo 'Unable to locate a Java Runtime.' >&2\nexit 1",
      );
      await script(
        join(dir, "jdk", "bin", "keytool"),
        `echo 'Certificate fingerprints:'\necho '\t SHA256: ${DEBUG_FINGERPRINT}'`,
      );
      const home = join(dir, "home");
      const working = await debugKeystoreReader({
        ANDROID_USER_HOME: home,
        PATH: join(dir, "stub"),
        JAVA_HOME: join(dir, "jdk"),
      })();
      expect(working).toMatchObject({
        status: "found",
        fingerprint: DEBUG_FINGERPRINT,
        keytool: join(dir, "jdk", "bin", "keytool"),
      });
      const stubOnly = await debugKeystoreReader({
        ANDROID_USER_HOME: home,
        PATH: join(dir, "stub"),
        JAVA_HOME: join(dir, "none"),
        HOME: dir,
      })();
      expect(stubOnly).toMatchObject({ status: "failed" });
      expect(stubOnly.detail).toContain("Java Runtime");
      expect(
        await debugKeystoreReader({
          ANDROID_USER_HOME: home,
          PATH: join(dir, "none"),
          HOME: dir,
        })(),
      ).toMatchObject({
        status: process.platform === "darwin" ? expect.any(String) : "no-keytool",
      });
    },
  );

  test("reports no issue when the debug keystore isn't read", async () => {
    const skipped = await discoverIdentity(
      { applicationId: "a.b", applicationIdSource: "gradle" },
      undefined,
      false,
    );
    expect(skipped.issues).toEqual([]);
  });

  test("looks for keytool where each platform keeps it", () => {
    const windows = keytoolCandidates(
      {
        JAVA_HOME: "C:\\jdk",
        ProgramFiles: "C:\\Program Files",
        LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      },
      "win32",
    );
    expect(windows).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/C:\\jdk[\\/]bin[\\/]keytool\.exe$/),
        expect.stringMatching(
          /Program Files[\\/]Android[\\/]Android Studio[\\/]jbr[\\/]bin[\\/]keytool\.exe$/,
        ),
        expect.stringMatching(
          /AppData[\\/]Local[\\/]Programs[\\/]Android Studio[\\/]jbr[\\/]bin[\\/]keytool\.exe$/,
        ),
      ]),
    );
    expect(windows.some((candidate) => candidate.includes("/Applications/"))).toBe(false);
    const mac = keytoolCandidates({ JAVA_HOME: "/jdk" }, "darwin");
    expect(mac).toContain("/jdk/bin/keytool");
    expect(mac).toContain(
      "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool",
    );
  });

  test("names the Dashboard page when a registration lacks a fingerprint", () => {
    const message = missingFingerprintsMessage(
      "com.example.app",
      [DEBUG_FINGERPRINT],
      [RELEASE_FINGERPRINT],
    );
    expect(message).toContain("dashboard.clerk.com/~/native-applications");
    expect(message).toContain(DEBUG_FINGERPRINT);
    expect(message).toContain("can't update a registration yet");
  });
});
