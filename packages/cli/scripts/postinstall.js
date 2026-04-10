#!/usr/bin/env node
"use strict";

// Warn if a stale clerk binary is shadowing the one we just installed.
// Removal is left to `clerk update` where we have an interactive CLI context.
// This script must never throw or exit non-zero — that would fail the install.

const { spawnSync } = require("node:child_process");
const { platform } = require("node:process");

if (platform === "win32") process.exit(0); // `which -a` is not available on Windows

try {
  const prefixResult = spawnSync("npm", ["prefix", "-g"], { encoding: "utf8" });
  if (prefixResult.status !== 0 || !prefixResult.stdout) process.exit(0);

  const npmBinPath = `${prefixResult.stdout.trim()}/bin/clerk`;

  const whichResult = spawnSync("which", ["-a", "clerk"], { encoding: "utf8" });
  if (whichResult.status !== 0 || !whichResult.stdout) process.exit(0);

  const entries = whichResult.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const shadowing = entries.find((p) => p && p !== npmBinPath);

  if (shadowing) {
    console.warn(
      `\nWarning: found a clerk binary at ${shadowing} that may take precedence over this install.`,
    );
    console.warn(`  Run \`clerk update\` to remove it, or manually: rm ${shadowing}\n`);
  }
} catch {
  // Silently ignore — postinstall must not fail the install
}
