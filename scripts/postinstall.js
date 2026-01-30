#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

const VERSION = require("../package.json").version;
const REPO = "clerk/cli";

function getPlatformInfo() {
  const platform = process.platform;
  const arch = process.arch;

  let goos, goarch;

  switch (platform) {
    case "darwin":
      goos = "darwin";
      break;
    case "linux":
      goos = "linux";
      break;
    case "win32":
      goos = "windows";
      break;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }

  switch (arch) {
    case "x64":
      goarch = "amd64";
      break;
    case "arm64":
      goarch = "arm64";
      break;
    default:
      throw new Error(`Unsupported architecture: ${arch}`);
  }

  return { goos, goarch };
}

function getBinaryName(goos) {
  return goos === "windows" ? "clerk-bin.exe" : "clerk-bin";
}

function getAssetName(version, goos, goarch) {
  const ext = goos === "windows" ? ".exe" : "";
  return `clerk-v${version}-${goos}-${goarch}${ext}`;
}

function checkGhCli() {
  const result = spawnSync("gh", ["--version"], { stdio: "pipe" });
  return result.status === 0;
}

async function main() {
  const binDir = path.join(__dirname, "..", "bin");
  const { goos, goarch } = getPlatformInfo();
  const binaryName = getBinaryName(goos);
  const binaryPath = path.join(binDir, binaryName);

  // Create bin directory if it doesn't exist
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  // Skip download if binary already exists (for development)
  if (fs.existsSync(binaryPath)) {
    console.log("Clerk CLI binary already exists, skipping download");
    return;
  }

  if (!checkGhCli()) {
    console.error("Error: GitHub CLI (gh) is required but not installed.");
    console.error("Install it from: https://cli.github.com/");
    console.error("Then authenticate with: gh auth login");
    process.exit(1);
  }

  const assetName = getAssetName(VERSION, goos, goarch);
  console.log(`Downloading Clerk CLI v${VERSION} for ${goos}/${goarch}...`);

  try {
    // Use gh CLI to download the release asset
    const result = spawnSync(
      "gh",
      [
        "release",
        "download",
        `v${VERSION}`,
        "--repo",
        REPO,
        "--pattern",
        assetName,
        "--dir",
        binDir,
      ],
      { stdio: "inherit" }
    );

    if (result.status !== 0) {
      throw new Error(`gh release download failed with exit code ${result.status}`);
    }

    // Rename downloaded file to clerk-bin
    const downloadedPath = path.join(binDir, assetName);
    fs.renameSync(downloadedPath, binaryPath);

    // Make binary executable on Unix systems
    if (goos !== "windows") {
      fs.chmodSync(binaryPath, 0o755);
    }

    console.log("Clerk CLI installed successfully!");
  } catch (error) {
    console.error("Failed to download Clerk CLI:", error.message);
    console.error(
      "Make sure you're authenticated with GitHub CLI: gh auth login"
    );
    console.error(
      "You can also download manually from: https://github.com/clerk/cli/releases"
    );
    process.exit(1);
  }
}

main();
