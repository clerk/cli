import { describe, expect, test } from "bun:test";
import { renderFormula, computeChecksum, createArchive, parseMajorVersion } from "./homebrew.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("renderFormula", () => {
  test("renders formula with version and checksums", () => {
    const result = renderFormula({
      version: "1.2.3",
      checksums: {
        "darwin-arm64": "aaaa",
        "darwin-x64": "bbbb",
        "linux-arm64": "cccc",
        "linux-x64": "dddd",
      },
    });

    expect(result).toContain('version "1.2.3"');
    expect(result).toContain(
      "https://github.com/clerk/cli/releases/download/v1.2.3/homebrew-clerk-darwin-arm64.tar.gz",
    );
    expect(result).toContain('sha256 "aaaa"');
    expect(result).toContain(
      "https://github.com/clerk/cli/releases/download/v1.2.3/homebrew-clerk-darwin-x64.tar.gz",
    );
    expect(result).toContain('sha256 "bbbb"');
    expect(result).toContain(
      "https://github.com/clerk/cli/releases/download/v1.2.3/homebrew-clerk-linux-arm64.tar.gz",
    );
    expect(result).toContain('sha256 "cccc"');
    expect(result).toContain(
      "https://github.com/clerk/cli/releases/download/v1.2.3/homebrew-clerk-linux-x64.tar.gz",
    );
    expect(result).toContain('sha256 "dddd"');
    expect(result).toContain('bin.install "clerk"');
    expect(result).toContain("assert_match version.to_s");
  });

  test("output is valid Ruby (class Clerk < Formula)", () => {
    const result = renderFormula({
      version: "0.1.0",
      checksums: {
        "darwin-arm64": "a".repeat(64),
        "darwin-x64": "b".repeat(64),
        "linux-arm64": "c".repeat(64),
        "linux-x64": "d".repeat(64),
      },
    });

    expect(result).toStartWith("class Clerk < Formula\n");
    expect(result).toEndWith("end\n");
  });
});

describe("computeChecksum", () => {
  test("returns sha256 hex digest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "homebrew-test-"));
    const file = join(dir, "test.bin");
    await Bun.write(file, "hello world");
    const hash = await computeChecksum(file);
    // sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    expect(hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
    await rm(dir, { recursive: true });
  });
});

describe("createArchive", () => {
  test("creates a tar.gz containing a file named clerk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "homebrew-test-"));
    const binaryPath = join(dir, "clerk");
    await Bun.write(binaryPath, "fake binary content");

    const archivePath = join(dir, "test.tar.gz");
    createArchive(binaryPath, archivePath);

    expect(await Bun.file(archivePath).exists()).toBe(true);

    // Verify archive contains "clerk"
    const result = Bun.spawnSync(["tar", "tzf", archivePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const files = result.stdout.toString().trim().split("\n");
    expect(files).toContain("clerk");

    await rm(dir, { recursive: true });
  });
});

describe("parseMajorVersion", () => {
  test("extracts major from semver", () => {
    expect(parseMajorVersion("1.2.3")).toBe(1);
  });

  test("handles zero major", () => {
    expect(parseMajorVersion("0.5.1")).toBe(0);
  });

  test("handles major-only version", () => {
    expect(parseMajorVersion("3")).toBe(3);
  });

  test("throws on invalid version", () => {
    expect(() => parseMajorVersion("")).toThrow("Invalid version string");
  });
});
