import type { Program } from "../../cli-program.ts";
import { getValidToken } from "../../lib/credential-store.ts";
import { fetchUserInfo } from "../../lib/token-exchange.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";
import { AuthError } from "../../lib/errors.ts";
import { profileLabel, resolveProfile } from "../../lib/config.ts";
import { NEXT_STEPS, printNextSteps } from "../../lib/next-steps.ts";
import { isAgent } from "../../mode.ts";
import { bapiRequest } from "../../lib/bapi.ts";
import {
  findLocalPublishableKey,
  resolveKeylessTarget,
  type KeylessTarget,
} from "../../lib/keyless-target.ts";

export interface WhoamiOptions {
  json?: boolean;
}

/**
 * Who this directory is acting as: a Clerk account, or — with no account at all
 * — the unclaimed keyless application whose key the project holds. Resolving
 * this first keeps rendering to a single place.
 */
type Identity =
  | { kind: "account"; email: string; profile: Awaited<ReturnType<typeof resolveProfile>> }
  | {
      kind: "keyless";
      instanceId: string | null;
      environmentType: string | null;
      publishableKey: string | null;
      keySource: string;
    };

export async function whoami(options: WhoamiOptions = {}) {
  const identity = await resolveIdentity();

  if (options.json || isAgent()) {
    log.data(JSON.stringify(toJson(identity), null, 2));
    return;
  }

  render(identity);
}

async function resolveIdentity(): Promise<Identity> {
  const token = await getValidToken();

  // No account, but the directory may still hold a working keyless
  // application. Report what it is instead of a flat "not logged in".
  if (!token) {
    const keyless = await resolveKeylessTarget({ cwd: process.cwd() });
    if (!keyless) throw new AuthError({ reason: "not_logged_in" });
    return describeKeyless(keyless);
  }

  let userInfo;
  try {
    userInfo = await withSpinner("Fetching account info...", () => fetchUserInfo(token));
  } catch {
    throw new AuthError({ reason: "session_expired" });
  }

  let profile: Awaited<ReturnType<typeof resolveProfile>>;
  try {
    profile = await resolveProfile(process.cwd());
  } catch {
    // Best-effort only: don't fail whoami when local profile resolution fails.
    profile = undefined;
  }

  return { kind: "account", email: userInfo.email, profile };
}

async function describeKeyless(keyless: KeylessTarget): Promise<Identity> {
  const instance = await withSpinner("Fetching instance info...", async () => {
    const response = await bapiRequest({
      method: "GET",
      path: "/v1/instance",
      secretKey: keyless.secretKey,
    });
    return response.body as { id?: string; environment_type?: string };
  });

  return {
    kind: "keyless",
    instanceId: instance.id ?? null,
    environmentType: instance.environment_type ?? null,
    publishableKey: (await findLocalPublishableKey(process.cwd())) ?? null,
    keySource: keyless.source,
  };
}

function toJson(identity: Identity): Record<string, unknown> {
  if (identity.kind === "keyless") {
    const { kind: _kind, ...keyless } = identity;
    return { email: null, keyless, linked: null };
  }

  const resolved = identity.profile;
  return {
    email: identity.email,
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
  };
}

function render(identity: Identity): void {
  if (identity.kind === "keyless") {
    log.data(identity.instanceId ?? "unknown instance");
    log.info(
      `Not logged in — running on an unclaimed keyless application (key from \`${identity.keySource}\`)`,
    );
    printNextSteps(NEXT_STEPS.WHOAMI);
    return;
  }

  log.data(identity.email);
  if (identity.profile) {
    log.info(`Linked to \`${profileLabel(identity.profile.profile)}\``);
  }
  printNextSteps(identity.profile ? NEXT_STEPS.WHOAMI_LINKED : NEXT_STEPS.WHOAMI);
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
