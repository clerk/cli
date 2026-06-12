import type { Program } from "../../cli-program.ts";
import { getValidToken } from "../../lib/credential-store.ts";
import { fetchUserInfo } from "../../lib/token-exchange.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";
import { AuthError } from "../../lib/errors.ts";
import { profileLabel, resolveProfile } from "../../lib/config.ts";
import { NEXT_STEPS, printNextSteps } from "../../lib/next-steps.ts";
import { isAgent } from "../../mode.ts";

export interface WhoamiOptions {
  json?: boolean;
}

export async function whoami(options: WhoamiOptions = {}) {
  const token = await getValidToken();
  if (!token) {
    throw new AuthError({ reason: "not_logged_in" });
  }

  let userInfo;
  try {
    userInfo = await withSpinner("Fetching account info...", () => fetchUserInfo(token));
  } catch {
    throw new AuthError({ reason: "session_expired" });
  }

  let resolved: Awaited<ReturnType<typeof resolveProfile>>;
  try {
    resolved = await resolveProfile(process.cwd());
  } catch {
    // Best-effort only: don't fail whoami when local profile resolution fails.
    resolved = undefined;
  }

  if (options.json || isAgent()) {
    log.data(
      JSON.stringify(
        {
          email: userInfo.email,
          linked: resolved
            ? {
                appId: resolved.profile.appId,
                appName: resolved.profile.appName ?? null,
                instances: {
                  development: resolved.profile.instances.development,
                  production: resolved.profile.instances.production ?? null,
                },
                resolvedVia: resolved.resolvedVia,
                path: resolved.path,
              }
            : null,
        },
        null,
        2,
      ),
    );
    return;
  }

  log.data(userInfo.email);
  if (resolved) {
    log.info(`Linked to \`${profileLabel(resolved.profile)}\``);
  }
  printNextSteps(resolved ? NEXT_STEPS.WHOAMI_LINKED : NEXT_STEPS.WHOAMI);
}

export function registerWhoami(program: Program): void {
  program
    .command("whoami")
    .description("Show the current logged-in user and linked application")
    .option("--json", "Output JSON")
    .setExamples([
      { command: "clerk whoami", description: "Show your email and linked app" },
      { command: "clerk whoami --json", description: "Emit a structured payload on stdout" },
    ])
    .action((options) => whoami({ json: options.json }));
}
