import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { targets } from "./lib/targets.ts";

const ENTITLEMENTS_PATH = join(import.meta.dir, "entitlements.plist");
const KEYCHAIN_NAME = "clerk-signing.keychain-db";

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Resolves a configuration value from either a CLI flag or an environment
 * variable, preferring the flag when both are present. Throws if neither
 * source provides a value.
 */
export function requireEnvOrFlag(
  flagValue: string | undefined,
  envVar: string,
  label: string,
): string {
  const value = flagValue ?? process.env[envVar];
  if (!value) {
    throw new Error(`Missing ${label}: pass --${label} or set ${envVar}`);
  }
  return value;
}

/**
 * Returns the list of macOS (darwin) build targets. When `targetFilter` is
 * provided, returns only the matching target or throws if it does not exist.
 */
export function getDarwinTargets(targetFilter?: string) {
  const darwinTargets = targets.filter((t) => t.os === "darwin");

  if (!targetFilter) {
    return darwinTargets;
  }

  const matched = darwinTargets.filter((t) => t.name === targetFilter);
  if (matched.length === 0) {
    throw new Error(
      `Unknown darwin target: ${targetFilter}\nAvailable: ${darwinTargets.map((t) => t.name).join(", ")}`,
    );
  }

  return matched;
}

/**
 * Executes a command synchronously and returns its stdout. Throws on non-zero
 * exit. When `displayCmd` is provided it is used for logging and error messages
 * instead of `cmd`, so that secrets passed in argv are never printed.
 */
function run(cmd: string[], displayCmd = cmd): string {
  console.log(`$ ${displayCmd.join(" ")}`);
  const result = Bun.spawnSync(cmd, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(
      `${displayCmd.join(" ")} failed (exit ${result.exitCode})${stderr ? `:\n${stderr}` : ""}`,
    );
  }
  return result.stdout.toString().trim();
}

/**
 * Like `run`, but returns `undefined` instead of throwing on failure. When
 * `displayCmd` is provided it is used for logging and warning messages instead
 * of `cmd`, so that secrets passed in argv are never printed.
 */
function runMaybe(cmd: string[], displayCmd = cmd): string | undefined {
  console.log(`$ ${displayCmd.join(" ")} (non-fatal)`);
  const result = Bun.spawnSync(cmd, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    console.warn(
      `Warning: ${displayCmd.join(" ")} failed (exit ${result.exitCode})${stderr ? `: ${stderr}` : ""}`,
    );
    return undefined;
  }
  return result.stdout.toString().trim();
}

// ---------------------------------------------------------------------------
// Main — only runs when executed directly (not when imported by tests)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      target: { type: "string" },
      "artifacts-dir": { type: "string" },
      "certificate-base64": { type: "string" },
      "certificate-password": { type: "string" },
      "api-key-base64": { type: "string" },
      "api-key-id": { type: "string" },
      "api-issuer-id": { type: "string" },
    },
  });

  const artifactsDir = requireEnvOrFlag(values["artifacts-dir"], "ARTIFACTS_DIR", "artifacts-dir");
  const certificateBase64 = requireEnvOrFlag(
    values["certificate-base64"],
    "APPLE_CERTIFICATE_BASE64",
    "certificate-base64",
  );
  const certificatePassword = requireEnvOrFlag(
    values["certificate-password"],
    "APPLE_CERTIFICATE_PASSWORD",
    "certificate-password",
  );
  const apiKeyBase64 = requireEnvOrFlag(
    values["api-key-base64"],
    "APPLE_API_KEY_BASE64",
    "api-key-base64",
  );
  const apiKeyId = requireEnvOrFlag(values["api-key-id"], "APPLE_API_KEY_ID", "api-key-id");
  const apiIssuerId = requireEnvOrFlag(
    values["api-issuer-id"],
    "APPLE_API_ISSUER_ID",
    "api-issuer-id",
  );

  const selectedTargets = getDarwinTargets(values.target);

  console.log(
    `Signing ${selectedTargets.length} target(s): ${selectedTargets.map((t) => t.name).join(", ")}\n`,
  );

  // Use OS temp dir for secrets — never write them to the source tree
  const tempDir = process.env.RUNNER_TEMP ?? tmpdir();
  const apiKeyDir = join(tempDir, "clerk-sign-keys");
  const apiKeyPath = join(apiKeyDir, `AuthKey_${apiKeyId}.p8`);
  const certPath = join(tempDir, "clerk-sign-cert.p12");
  const keychainPassword = crypto.randomUUID();

  try {
    await mkdir(apiKeyDir, { recursive: true });
    await Bun.write(apiKeyPath, Buffer.from(apiKeyBase64, "base64"));

    // -- Create temporary keychain and import certificate --
    await Bun.write(certPath, Buffer.from(certificateBase64, "base64"));

    run(
      ["security", "create-keychain", "-p", keychainPassword, KEYCHAIN_NAME],
      ["security", "create-keychain", "-p", "***", KEYCHAIN_NAME],
    );
    run(["security", "set-keychain-settings", "-lut", "21600", KEYCHAIN_NAME]);
    run(
      ["security", "unlock-keychain", "-p", keychainPassword, KEYCHAIN_NAME],
      ["security", "unlock-keychain", "-p", "***", KEYCHAIN_NAME],
    );

    run(
      [
        "security",
        "import",
        certPath,
        "-k",
        KEYCHAIN_NAME,
        "-P",
        certificatePassword,
        "-T",
        "/usr/bin/codesign",
      ],
      ["security", "import", certPath, "-k", KEYCHAIN_NAME, "-P", "***", "-T", "/usr/bin/codesign"],
    );

    // Allow codesign to access the keychain without UI prompts
    run(
      [
        "security",
        "set-key-partition-list",
        "-S",
        "apple-tool:,apple:,codesign:",
        "-s",
        "-k",
        keychainPassword,
        KEYCHAIN_NAME,
      ],
      [
        "security",
        "set-key-partition-list",
        "-S",
        "apple-tool:,apple:,codesign:",
        "-s",
        "-k",
        "***",
        KEYCHAIN_NAME,
      ],
    );

    // Prepend our keychain to the search list
    const existingKeychains = run(["security", "list-keychains", "-d", "user"]);
    const keychainList = existingKeychains
      .split("\n")
      .map((k) => k.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    run(["security", "list-keychains", "-d", "user", "-s", KEYCHAIN_NAME, ...keychainList]);

    // -- Extract signing identity --
    const identityOutput = run([
      "security",
      "find-identity",
      "-v",
      "-p",
      "codesigning",
      KEYCHAIN_NAME,
    ]);
    const identityMatch = identityOutput.match(/"([^"]+)"/);
    if (!identityMatch?.[1]) {
      throw new Error(`No codesigning identity found in keychain.\nOutput: ${identityOutput}`);
    }
    const identity = identityMatch[1];
    console.log(`Signing identity: ${identity}\n`);

    // -- Sign and notarize each target --
    for (const target of selectedTargets) {
      const binaryPath = join(artifactsDir, target.name, "clerk");
      console.log(`\n--- ${target.name} ---`);

      // Code sign with hardened runtime
      run([
        "codesign",
        "--sign",
        identity,
        "--keychain",
        KEYCHAIN_NAME,
        "--entitlements",
        ENTITLEMENTS_PATH,
        "--options",
        "runtime",
        "--timestamp",
        "--force",
        binaryPath,
      ]);

      // Verify signature
      run(["codesign", "--verify", "--verbose", binaryPath]);

      // Create ZIP for notarization (Apple requires ditto format)
      const zipPath = `${binaryPath}.zip`;
      run(["ditto", "-c", "-k", "--keepParent", binaryPath, zipPath]);

      // Submit for notarization (don't use run() — notarytool may exit non-zero
      // while still emitting valid JSON to stdout, e.g. status "Invalid")
      console.log("Submitting for notarization...");
      const notaryCmd = [
        "xcrun",
        "notarytool",
        "submit",
        zipPath,
        "--key",
        apiKeyPath,
        "--key-id",
        apiKeyId,
        "--issuer",
        apiIssuerId,
        "--output-format",
        "json",
        "--wait",
        "--timeout",
        "30m",
      ];
      console.log(`$ ${notaryCmd.join(" ")}`);
      const notaryProc = Bun.spawnSync(notaryCmd, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const notaryStdout = notaryProc.stdout.toString().trim();
      const notaryStderr = notaryProc.stderr.toString().trim();
      if (notaryStderr) {
        console.error(notaryStderr);
      }

      // Parse notarization result from stdout (available regardless of exit code)
      let notaryResult: { id?: string; status?: string };
      try {
        notaryResult = JSON.parse(notaryStdout);
      } catch {
        throw new Error(
          `Failed to parse notarytool output (exit ${notaryProc.exitCode}):\n${notaryStdout}`,
        );
      }

      console.log(
        `Notarization status: ${notaryResult.status ?? "unknown"} (id: ${notaryResult.id ?? "unknown"})`,
      );

      if (notaryResult.status !== "Accepted") {
        // Fetch and display the notarization log for debugging
        if (notaryResult.id) {
          const log = runMaybe([
            "xcrun",
            "notarytool",
            "log",
            notaryResult.id,
            "--key",
            apiKeyPath,
            "--key-id",
            apiKeyId,
            "--issuer",
            apiIssuerId,
          ]);
          if (log) {
            console.error("Notarization log:\n" + log);
          }
        }
        throw new Error(`Notarization failed with status: ${notaryResult.status}`);
      }

      // Clean up the ZIP
      await Bun.file(zipPath).delete();

      console.log(`${target.name} signed and notarized successfully.`);
    }

    console.log("\nAll targets signed and notarized successfully.");
  } finally {
    // -- Cleanup: keychain, certificate, and API key --
    runMaybe(["security", "delete-keychain", KEYCHAIN_NAME]);
    await rm(certPath, { force: true });
    await rm(apiKeyDir, { recursive: true, force: true });
  }
}
