import { basename } from "node:path";
import { search, confirm, input } from "@inquirer/prompts";
import { isAgent } from "../../mode.ts";
import { getToken } from "../../lib/credential-store.ts";
import { login } from "../auth/login.ts";
import {
  listApplications,
  fetchApplication,
  createApplication,
  type Application,
} from "../../lib/plapi.ts";
import { setProfile, resolveProfile, moveProfile } from "../../lib/config.ts";
import { autolink, findClerkKeys, matchKeyToApp } from "../../lib/autolink.ts";
import { getGitRepoIdentifier, getGitRepoRoot, getGitNormalizedRemote } from "../../lib/git.ts";
import { dim, cyan } from "../../lib/color.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";
import { CliError, PlapiError, ERROR_CODE, withApiContext } from "../../lib/errors.ts";
import { intro, outro, withSpinner } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";

const AGENT_PROMPT = `You are linking a Clerk application to the current project directory.

## Steps

1. Ensure the user is authenticated. If not, run \`clerk auth login\` first.
2. Determine which application to link:
   - If the user provides an app ID: \`clerk link --app <app_id>\`
   - Otherwise, list available applications with \`GET /v1/platform/applications\` and ask the user to select one.
   - If no applications exist, or the user wants a new one, create one with \`POST /v1/platform/applications\`, then fetch its details with \`GET /v1/platform/applications/{appId}\`.
3. The link is stored in ~/.clerk/config.json as a profile keyed by the git repository root (shared across worktrees).

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /v1/platform/applications | List all applications |
| GET | /v1/platform/applications/{appId} | Fetch application with instance details |
| POST | /v1/platform/applications | Create a new application |`;

const CREATE_NEW_APP = "__create_new__";

interface LinkOptions {
  app?: string;
  skipIfLinked?: boolean;
}

function appLabel(app: Application): string {
  return app.name ? `${app.name} (${app.application_id})` : app.application_id;
}

export async function link(options: LinkOptions = {}): Promise<void> {
  if (isAgent()) {
    log.data(AGENT_PROMPT);
    return;
  }

  const cwd = process.cwd();
  const repoRoot = await getGitRepoRoot();
  const normalizedRemote = await getGitNormalizedRemote();
  const repoId = await getGitRepoIdentifier();
  const profileKey = normalizedRemote ?? repoId ?? cwd;
  const displayPath = repoRoot ?? cwd;

  const existing = await resolveProfile(cwd);
  const targetsDifferentApp = options.app && existing && options.app !== existing.profile.appId;

  if (existing && options.skipIfLinked && !targetsDifferentApp) {
    printExistingStatus(existing, normalizedRemote);
    return;
  }

  if (!existing && options.skipIfLinked && !options.app) {
    const autolinked = await autolink(cwd);
    if (autolinked) return;
  }

  intro("clerk link");

  if (existing) {
    const shouldRelink = await handleExistingProfile(existing, normalizedRemote, options);
    if (!shouldRelink) {
      outro();
      return;
    }
  }

  await ensureAuth();

  const app = options.app
    ? await withApiContext(fetchApplication(options.app), "Failed to fetch application")
    : await resolveApp(cwd, displayPath, !existing);

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

  outro(NEXT_STEPS.LINK);
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

async function createAndFetchApp(name: string): Promise<Application> {
  const created = await withApiContext(createApplication(name), "Failed to create application");
  return withApiContext(fetchApplication(created.application_id), "Failed to fetch application");
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
      fetchApplication(options.app),
      "Failed to fetch application",
    );
    return confirm({ message: `Re-link to ${cyan(appLabel(targetApp))}?`, default: false });
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
): Promise<Application> {
  let apps: Application[];
  try {
    apps = await withSpinner("Fetching applications...", () =>
      withApiContext(listApplications(), "Failed to fetch applications"),
    );
  } catch (error) {
    if (error instanceof PlapiError && error.status >= 500) {
      log.info("Could not fetch your applications — you can still create a new one");
      apps = [];
    } else {
      throw error;
    }
  }

  if (apps.length > 0 && detectKeys) {
    const detected = await tryDetectApp(cwd, apps);
    if (detected) return detected;
  }

  return pickOrCreateApp(apps, displayPath);
}

async function pickOrCreateApp(apps: Application[], displayPath: string): Promise<Application> {
  const appChoices = apps.map((a) => ({ name: appLabel(a), value: a.application_id }));
  const createChoice = { name: dim("+ Create a new application"), value: CREATE_NEW_APP };

  const selectedId = await search({
    message: `Select a Clerk application to link ${dim(`(repo: ${basename(displayPath)})`)}`,
    source: (term: string | undefined) => {
      const filtered = term
        ? appChoices.filter((c) => c.name.toLowerCase().includes(term.toLowerCase()))
        : appChoices;
      return [...filtered, createChoice];
    },
  });

  if (selectedId === CREATE_NEW_APP) {
    const name = await input({
      message: "Application name:",
      validate: (v) => (v.trim() ? true : "Application name cannot be empty"),
    });
    return createAndFetchApp(name.trim());
  }

  const found = apps.find((a) => a.application_id === selectedId);
  if (!found) {
    throw new CliError("Selected application not found", {
      code: ERROR_CODE.APP_NOT_FOUND,
    });
  }
  return found;
}
