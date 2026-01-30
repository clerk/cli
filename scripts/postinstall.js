#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawnSync } = require("child_process");

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

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          // Follow redirect
          file.close();
          fs.unlinkSync(dest);
          downloadFile(response.headers.location, dest)
            .then(resolve)
            .catch(reject);
          return;
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      })
      .on("error", (err) => {
        file.close();
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

async function tryDirectDownload(assetName, binaryPath) {
  const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${assetName}`;
  console.log(`Downloading from ${url}...`);
  await downloadFile(url, binaryPath);
}

function tryGhDownload(assetName, binDir, binaryPath) {
  const result = spawnSync("gh", ["--version"], { stdio: "pipe" });
  if (result.status !== 0) {
    return false;
  }

  console.log("Trying GitHub CLI...");
  const downloadResult = spawnSync(
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

  if (downloadResult.status !== 0) {
    return false;
  }

  // Rename downloaded file to clerk-bin
  const downloadedPath = path.join(binDir, assetName);
  fs.renameSync(downloadedPath, binaryPath);
  return true;
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

  const assetName = getAssetName(VERSION, goos, goarch);
  console.log(`Installing Clerk CLI v${VERSION} for ${goos}/${goarch}...`);

  try {
    // Try direct download first (works for public repos)
    await tryDirectDownload(assetName, binaryPath);
  } catch (err) {
    // Fall back to gh CLI (works for private repos if authenticated)
    console.log(`Direct download failed (${err.message}), trying GitHub CLI...`);
    if (!tryGhDownload(assetName, binDir, binaryPath)) {
      console.error("Failed to download Clerk CLI.");
      console.error(
        "For private repos, install GitHub CLI (https://cli.github.com) and run: gh auth login"
      );
      console.error(
        `You can also download manually from: https://github.com/${REPO}/releases`
      );
      process.exit(1);
    }
  }

  // Make binary executable on Unix systems
  if (goos !== "windows") {
    fs.chmodSync(binaryPath, 0o755);
  }

  console.log("Clerk CLI installed successfully!");
}

main();
