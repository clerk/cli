import { join } from "node:path";
import { login } from "../auth/login.js";
import { link } from "../link/index.js";
import { pull } from "../env/pull.js";
import { detectFramework } from "../../lib/framework.js";
import { isHuman } from "../../mode.js";
import { cyan } from "../../lib/color.js";
import { createCommandOutput } from "../../lib/cli.js";
import { getToken } from "../../lib/credential-store.js";
import { resolveProfile } from "../../lib/config.js";
import { CliError } from "../../lib/errors.js";
import { getRecipe } from "./recipes/index.js";

// ── Package manager detection ──────────────────────────────────────────────

const PM_CHECKS: Array<{ files: string[]; add: string }> = [
  { files: ["bun.lockb", "bun.lock"], add: "bun add" },
  { files: ["yarn.lock"], add: "yarn add" },
  { files: ["pnpm-lock.yaml"], add: "pnpm add" },
];

/** Returns the install command for the detected package manager (e.g. "bun add", "npm install"). */
async function detectPackageManager(cwd: string): Promise<string> {
  for (const { files, add } of PM_CHECKS) {
    for (const file of files) {
      if (await Bun.file(join(cwd, file)).exists()) {
        return add;
      }
    }
  }
  return "npm install";
}

async function installSdk(cwd: string, sdk: string, frameworkName: string): Promise<void> {
  const pm = await detectPackageManager(cwd);
  console.log(`  Installing ${cyan(sdk)} for ${frameworkName}...`);

  const proc = Bun.spawn(pm.split(" ").concat(sdk), {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(`  Failed to install ${sdk}. You can install it manually: ${pm} ${sdk}`);
  }
}

export async function init() {
  using out = createCommandOutput("init");
  const cwd = process.cwd();

  if (isHuman()) {
    // Human mode: run the full interactive flow (login/link throw on failure)
    await login();
    out.add("authenticated", true, "Logged in");

    await link({ skipIfLinked: true });

    // Verify link succeeded — link() doesn't return a value, so check directly
    const profile = await resolveProfile(cwd);
    if (!profile) {
      throw new CliError("Failed to link application. Run `clerk link` to link manually.");
    }
    out.add("linked", true, `Linked to ${profile.profile.appId}`);
  } else {
    // Agent mode: check pre-requisites without side effects
    const token = await getToken();
    out.add(
      "authenticated",
      !!token,
      token ? "Logged in" : "Not authenticated",
      "clerk auth login",
    );
    if (!token) return;

    const profile = await resolveProfile(cwd);
    out.add(
      "linked",
      !!profile,
      profile ? `Linked to ${profile.profile.appId}` : "Not linked",
      "clerk link",
    );
    if (!profile) return;
  }

  const fw = await detectFramework(cwd);

  if (fw) {
    out.add("framework", true, `Detected ${fw.name}`);

    if (isHuman()) {
      await installSdk(cwd, fw.sdk, fw.name);
      out.add("sdk", true, `Installed ${fw.sdk}`);
    } else {
      const pm = await detectPackageManager(cwd);
      out.add("sdk", false, `${fw.sdk} needed`, `${pm} ${fw.sdk}`);
    }
  } else {
    out.add(
      "framework",
      false,
      "Could not detect framework",
      "See https://clerk.com/docs for SDK installation",
    );
  }

  if (isHuman()) {
    await pull({});
    out.add("env", true, "Environment variables pulled");
  } else {
    out.add("env", false, "Environment variables not pulled", "clerk env pull");
  }

  if (fw) {
    const recipe = getRecipe(fw.dep);
    if (recipe) {
      out.meta("recipe", recipe);
      if (isHuman()) {
        console.log();
        console.log(recipe);
      }
    }
  }
}
