import type { Program } from "../../cli-program.ts";
import { basename } from "node:path";
import { confirm } from "../../lib/prompts.ts";
import { isAgent } from "../../mode.ts";
import { getToken } from "../../lib/credential-store.ts";
import { login } from "../auth/login.ts";
import { createApplication, fetchApplication, type Application } from "../../lib/plapi.ts";
import { appLabel, fetchAppsTolerantly, pickOrCreateApp } from "../../lib/app-picker.ts";
import { setProfile, resolveProfile, moveProfile } from "../../lib/config.ts";
import { autolink, findClerkKeys, matchKeyToApp } from "../../lib/autolink.ts";
import { getGitRepoIdentifier, getGitRepoRoot, getGitNormalizedRemote } from "../../lib/git.ts";
import { dim, cyan } from "../../lib/color.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";
import { CliError, ERROR_CODE, throwUsageError, withApiContext } from "../../lib/errors.ts";
import { intro, outro } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";

interface LinkOptions {
  app?: string;
  skipIfLinked?: boolean;
  cwd?: string;
  /**
   * In agent mode without `--app` and no existing profile, auto-create a new
   * Clerk application with this name and link to it instead of failing with a
   * usage error. Used by `clerk init` to keep the authed-agent flow non-
   * interactive end-to-end.
   */
  createIfMissing?: string;
  /**
   * Skip generic process-env/dotenv key discovery when those sources are not
   * runtime inputs for the calling framework. Native iOS direct setup uses
   * this so a web app's ambient key cannot silently choose the embedded app.
   */
  skipAutolink?: boolean;
  /**
   * Require the developer to affirm an existing application. Used when a
   * native project contains an opaque custom key source that must be preserved.
   */
  requireExistingAppSelection?: boolean;
}

export async function link(options: LinkOptions = {}): Promise<void> {
  const agent = isAgent();
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = await getGitRepoRoot(cwd);
  const normalizedRemote = await getGitNormalizedRemote(cwd);
  const repoId = await getGitRepoIdentifier(cwd);
  const profileKey = normalizedRemote ?? repoId ?? cwd;
  const displayPath = repoRoot ?? cwd;

  const existing = await resolveProfile(cwd);
  const targetsDifferentApp = options.app && existing && options.app !== existing.profile.appId;

  if (
    existing &&
    options.skipIfLinked &&
    !targetsDifferentApp &&
    !options.requireExistingAppSelection
  ) {
    printExistingStatus(existing, normalizedRemote);
    return;
  }

  if (!existing && !options.app && !options.skipAutolink && (options.skipIfLinked || agent)) {
    const autolinked = await autolink(cwd);
    if (autolinked) return;
  }

  if (agent && !existing && !options.app && !options.createIfMissing) {
    throwUsageError(
      "Cannot select an application in agent mode. Pass --app <id>, or run `clerk apps list --json` and retry.",
    );
  }

  intro("Linking project");

  if (existing && agent) {
    printExistingStatus(existing, normalizedRemote);
    if (!targetsDifferentApp) {
      await outro();
      return;
    }
  } else if (existing) {
    const shouldRelink = await handleExistingProfile(existing, normalizedRemote, options);
    if (!shouldRelink) {
      await outro();
      return;
    }
  }

  await ensureAuth();

  const app = options.app
    ? await withApiContext(
        fetchApplication(options.app, { includeSecretKeys: false }),
        "Failed to fetch application",
      )
    : agent && options.createIfMissing
      ? await withApiContext(
          createApplication(options.createIfMissing),
          "Failed to create application",
        )
      : await resolveApp(
          cwd,
          displayPath,
          !existing && !options.skipAutolink,
          options.requireExistingAppSelection !== true,
        );

  const devInstance = app.instances.find((i) => i.environment_type === "development");
  const prodInstance = app.instances.find((i) => i.environment_type === "production");

  if (!devInstance) {
    throw new CliError("Application has no development instance", {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
    });
  }

  await setProfile(profileKey, {
    workspaceId: "",
    appId: app.application_id,
    appName: app.name,
    instances: {
      development: devInstance.instance_id,
      ...(prodInstance ? { production: prodInstance.instance_id } : {}),
    },
  });

  const label = app.name || app.application_id;
  log.success(`Linked to ${cyan(label)} in ${dim(displayPath)}`);

  await outro(NEXT_STEPS.LINK);
}

async function ensureAuth() {
  // CLERK_PLATFORM_API_KEY is a valid non-interactive auth mechanism.
  // The PLAPI fetch helpers use it directly for API calls, so no OAuth
  // token is needed when this key is present.
  if (process.env.CLERK_PLATFORM_API_KEY) return;
  const token = await getToken();
  if (!token) {
    log.info("Not logged in. Authenticating first...");
    await login({ showNextSteps: false });
  }
}

function printExistingStatus(
  existing: Awaited<ReturnType<typeof resolveProfile>> & {},
  normalizedRemote: string | undefined,
) {
  if (existing.resolvedVia === "remote") {
    log.info(`Auto-linked via git remote (${dim(normalizedRemote ?? existing.path)})`);
  } else {
    const label = existing.profile.appName
      ? `${existing.profile.appName} (${existing.profile.appId})`
      : existing.profile.appId;
    log.info(`Already linked to ${cyan(label)} in ${dim(existing.path)}`);
  }
}

async function handleExistingProfile(
  existing: Awaited<ReturnType<typeof resolveProfile>> & {},
  normalizedRemote: string | undefined,
  options: LinkOptions,
): Promise<boolean> {
  printExistingStatus(existing, normalizedRemote);

  if (existing.availableRemote) {
    log.info(
      `We detected this is now a git repository with remote ${dim(existing.availableRemote)}.`,
    );
    const upgrade = await confirm({
      message: "Update the link to use the git remote? This shares it across clones and worktrees.",
      default: true,
    });
    if (upgrade) {
      await moveProfile(existing.path, existing.availableRemote);
      log.info(`\nLink updated to use git remote (${cyan(existing.availableRemote)})`);
      return false;
    }
  }

  if (options.app) {
    await ensureAuth();
    const targetApp = await withApiContext(
      fetchApplication(options.app, { includeSecretKeys: false }),
      "Failed to fetch application",
    );
    return confirm({ message: `Re-link to ${cyan(appLabel(targetApp))}?`, default: false });
  }

  if (options.requireExistingAppSelection) {
    const label = existing.profile.appName
      ? `${existing.profile.appName} (${existing.profile.appId})`
      : existing.profile.appId;
    const keepExisting = await confirm({
      message: `Use ${cyan(label)} for this preserved iOS key configuration?`,
      default: true,
    });
    return !keepExisting;
  }

  return confirm({ message: "Re-link to a different application?", default: false });
}

async function tryDetectApp(cwd: string, apps: Application[]): Promise<Application | undefined> {
  const detectedKeys = await findClerkKeys(cwd);
  if (!detectedKeys.length) return undefined;

  const match = matchKeyToApp(detectedKeys, apps);
  if (!match) return undefined;

  log.info(`We found ${cyan(appLabel(match.app))} from ${dim(match.source)}.`);
  const useDetected = await confirm({ message: "Link to this application?", default: true });
  return useDetected ? match.app : undefined;
}

async function resolveApp(
  cwd: string,
  displayPath: string,
  detectKeys: boolean,
  allowCreate = true,
): Promise<Application> {
  const apps = await fetchAppsTolerantly();

  if (apps.length > 0 && detectKeys) {
    const detected = await tryDetectApp(cwd, apps);
    if (detected) return detected;
  }

  return pickOrCreateApp({
    apps,
    message: `Select a Clerk application to link ${dim(`(repo: ${basename(displayPath)})`)}`,
    allowCreate,
  });
}

export function registerLink(program: Program): void {
  program
    .command("link")
    .description("Link this project to a Clerk application")
    .option("--app <id>", "Application ID to link (skips interactive picker)")
    .setExamples([
      { command: "clerk link", description: "Pick an app interactively" },
      { command: "clerk link --app app_abc123", description: "Link directly by application ID" },
    ])
    .action(link);
}
