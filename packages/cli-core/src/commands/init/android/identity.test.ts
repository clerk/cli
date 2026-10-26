import { describe, expect, test } from "bun:test";
import {
  debugKeystoreNote,
  debugKeystorePath,
  discoverIdentity,
  missingFingerprintsMessage,
  normalizeFingerprints,
} from "./identity.ts";
import { DEBUG_FINGERPRINT, RELEASE_FINGERPRINT, keystore } from "./test-helpers.ts";

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

  test("says what to do when the debug certificate can't be read", async () => {
    for (const status of ["no-keystore", "no-keytool", "failed"] as const) {
      const identity = await discoverIdentity(
        { applicationId: "com.example.app", applicationIdSource: "gradle" },
        undefined,
        keystore(status),
      );
      expect(identity.fingerprints).toEqual([]);
      expect(identity.issues[0]).toContain("--android-fingerprint");
      expect(debugKeystoreNote(identity.debug)).toBe(identity.issues[0]);
    }
    const skipped = await discoverIdentity(
      { applicationId: "a.b", applicationIdSource: "gradle" },
      undefined,
      false,
    );
    expect(skipped.issues).toEqual([]);
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
