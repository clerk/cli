import { join } from "node:path";
import { tmpdir } from "node:os";
import { targets } from "./targets.ts";

// Homebrew supports macOS and Linux (glibc only). Derive the subset from the
// canonical targets list so adding/removing a target in targets.ts automatically
// updates the Homebrew build.
type HomebrewTarget = (typeof targets)[number] & { os: "darwin" | "linux"; libc?: "glibc" };
export type HomebrewTargetName = HomebrewTarget["name"];

export const HOMEBREW_TARGETS = targets.filter(
  (t): t is HomebrewTarget =>
    (t.os === "darwin" || t.os === "linux") && (!("libc" in t) || t.libc !== "musl"),
);

export interface FormulaInput {
  version: string;
  checksums: Record<HomebrewTargetName, string>;
}

function assetUrl(version: string, target: string): string {
  return `https://github.com/clerk/cli/releases/download/v${version}/homebrew-clerk-${target}.tar.gz`;
}

export function renderFormula(input: FormulaInput): string {
  const { version, checksums } = input;

  return `class Clerk < Formula
  desc "The Clerk CLI"
  homepage "https://clerk.com"
  version "${version}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "${assetUrl(version, "darwin-arm64")}"
      sha256 "${checksums["darwin-arm64"]}"
    end
    if Hardware::CPU.intel?
      url "${assetUrl(version, "darwin-x64")}"
      sha256 "${checksums["darwin-x64"]}"
    end
  end

  on_linux do
    if Hardware::CPU.arm? && Hardware::CPU.is_64_bit?
      url "${assetUrl(version, "linux-arm64")}"
      sha256 "${checksums["linux-arm64"]}"
    end
    if Hardware::CPU.intel?
      url "${assetUrl(version, "linux-x64")}"
      sha256 "${checksums["linux-x64"]}"
    end
  end

  def install
    bin.install "clerk"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/clerk --version")
  end
end
`;
}

/**
 * Extracts the major version number from a semver string.
 */
export function parseMajorVersion(version: string): number {
  return parseInt(version.split(".")[0], 10);
}

/**
 * Creates a tar.gz archive containing just the binary renamed to "clerk".
 * Stages the rename in a temp directory so the archive entry name is always "clerk".
 */
export function createArchive(binaryPath: string, archivePath: string): void {
  const stageDir = join(
    tmpdir(),
    `homebrew-stage-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const result = Bun.spawnSync(["mkdir", "-p", stageDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.exitCode !== 0) {
    throw new Error(`mkdir failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`);
  }

  const stagedBinary = join(stageDir, "clerk");
  const cpResult = Bun.spawnSync(["cp", binaryPath, stagedBinary], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (cpResult.exitCode !== 0) {
    throw new Error(`cp failed (exit ${cpResult.exitCode}): ${cpResult.stderr.toString().trim()}`);
  }

  const tarResult = Bun.spawnSync(["tar", "czf", archivePath, "-C", stageDir, "clerk"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (tarResult.exitCode !== 0) {
    throw new Error(
      `tar failed (exit ${tarResult.exitCode}): ${tarResult.stderr.toString().trim()}`,
    );
  }
}

/**
 * Reads a file and returns its SHA256 hex digest.
 */
export async function computeChecksum(filePath: string): Promise<string> {
  const buffer = await Bun.file(filePath).arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(buffer);
  return hasher.digest("hex");
}
