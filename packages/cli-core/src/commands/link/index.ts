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
import { printNextSteps } from "../../lib/next-steps.ts";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";

const AGENT_PROMPT = `You are linking a Clerk application to the current project directory.

## Steps

1. Ensure the user is authenticated. If not, run \`clerk auth login\` first.
2. Determine which application to link:
   - If the user provides an app ID: \`clerk link --app <app_id>\`
   - To create a new application: \`clerk link --create-app "My App"\`
   - Otherwise, list available applications with \`GET /v1/platform/applications\` and ask the user to select one.
3. The link is stored in ~/.clerk/config.json as a profile keyed by the git repository root (shared across worktrees).

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /v1/platform/applications | List all applications |
| GET | /v1/platform/applications/{appId} | Fetch application with instance details |
| POST | /v1/platform/applications | Create a new application |`;

const CREATE_NEW_APP = "__create_new__" as const;

interface LinkOptions {
  app?: string;
  createApp?: string;
  skipIfLinked?: boolean;
}

function appLabel(app: Application): string {
  return app.name ? `${app.name} (${app.application_id})` : app.application_id;
}

export async function link(options: LinkOptions = {}): Promise<void> {
  if (isAgent()) {
    console.log(AGENT_PROMPT);
    return;
  }

  const cwd = process.cwd();
  const repoRoot = await getGitRepoRoot();
  const normalizedRemote = await getGitNormalizedRemote();
  const repoId = await getGitRepoIdentifier();
  const profileKey = normalizedRemote ?? repoId ?? cwd;
  const displayPath = repoRoot ?? cwd;

  const existing = await resolveProfile(cwd);

  if (existing && options.skipIfLinked) {
    printExistingStatus(existing, normalizedRemote);
    return;
  }

  if (!existing && options.skipIfLinked && !options.app) {
    const autolinked = await autolink(cwd);
    if (autolinked) return;
  }

  if (existing) {
    const shouldRelink = await handleExistingProfile(existing, normalizedRemote, options);
    if (!shouldRelink) return;
  }

  await ensureAuth();

  const app = options.app
    ? await fetchApplication(options.app)
    : options.createApp
      ? await createAndFetchApp(options.createApp)
      : await resolveApp(cwd, displayPath, !existing);

  const devInstance = app.instances.find((i) => i.environment_type === "development");
  const prodInstance = app.instances.find((i) => i.environment_type === "production");

  if (!devInstance) {
    throw new CliError("Application has no development instance.", {
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
  console.log(`\nLinked to ${cyan(label)} in ${dim(displayPath)}`);

  printNextSteps([
    "Run `clerk env pull` to fetch your environment variables",
    "Run `clerk doctor` to verify your setup",
  ]);
}

async function ensureAuth() {
  // CLERK_PLATFORM_API_KEY is a valid non-interactive auth mechanism.
  // The PLAPI fetch helpers use it directly for API calls, so no OAuth
  // token is needed when this key is present.
  if (process.env.CLERK_PLATFORM_API_KEY) return;
  const token = await getToken();
  if (!token) {
    console.log("Not logged in. Authenticating first...");
    await login({ showNextSteps: false });
  }
}

function printExistingStatus(
  existing: Awaited<ReturnType<typeof resolveProfile>> & {},
  normalizedRemote: string | undefined,
) {
  if (existing.resolvedVia === "remote") {
    console.log(`Auto-linked via git remote (${dim(normalizedRemote ?? existing.path)})`);
  } else {
    console.log(`Already linked to ${cyan(existing.profile.appId)} in ${dim(existing.path)}`);
  }
}

async function handleExistingProfile(
  existing: Awaited<ReturnType<typeof resolveProfile>> & {},
  normalizedRemote: string | undefined,
  options: LinkOptions,
): Promise<boolean> {
  printExistingStatus(existing, normalizedRemote);

  if (existing.availableRemote) {
    console.log(
      `We detected this is now a git repository with remote ${dim(existing.availableRemote)}.`,
    );
    const upgrade = await confirm({
      message: "Update the link to use the git remote? This shares it across clones and worktrees.",
      default: true,
    });
    if (upgrade) {
      await moveProfile(existing.path, existing.availableRemote);
      console.log(`\nLink updated to use git remote (${cyan(existing.availableRemote)})`);
      return false;
    }
  }

  if (options.app) {
    await ensureAuth();
    const targetApp = await fetchApplication(options.app);
    return confirm({ message: `Re-link to ${cyan(appLabel(targetApp))}?`, default: false });
  }

  return confirm({ message: "Re-link to a different application?", default: false });
}

async function createAndFetchApp(name: string): Promise<Application> {
  const created = await createApplication(name);
  console.log(`\nCreated ${cyan(created.name ?? created.application_id)}`);
  return fetchApplication(created.application_id);
}

async function resolveApp(
  cwd: string,
  displayPath: string,
  detectKeys: boolean,
): Promise<Application> {
  const apps = await listApplications();

  if (apps.length > 0 && detectKeys) {
    const detectedKeys = await findClerkKeys(cwd);
    const match = detectedKeys.length > 0 ? matchKeyToApp(detectedKeys, apps) : undefined;

    if (match) {
      const label = appLabel(match.app);
      console.log(`We found ${cyan(label)} from ${dim(match.source)}.`);
      const useDetected = await confirm({
        message: "Link to this application?",
        default: true,
      });
      if (useDetected) return match.app;
    }
  }

  return pickOrCreateApp(apps, displayPath);
}

async function pickOrCreateApp(apps: Application[], displayPath: string): Promise<Application> {
  const choices = [
    ...apps.map((a) => ({ name: appLabel(a), value: a.application_id })),
    { name: dim("+ Create a new application"), value: CREATE_NEW_APP },
  ];

  const selectedId = await search({
    message: `Select a Clerk application to link ${dim(`(repo: ${basename(displayPath)})`)}`,
    source: (term) => {
      if (!term) return choices;
      const lower = term.toLowerCase();
      return choices.filter((c) => c.name.toLowerCase().includes(lower));
    },
  });

  if (selectedId !== CREATE_NEW_APP) {
    const found = apps.find((a) => a.application_id === selectedId);
    if (!found) {
      throw new CliError("Selected application not found.", {
        code: ERROR_CODE.APP_NOT_FOUND,
      });
    }
    return found;
  }

  const name = await input({ message: "Application name:" });
  if (!name.trim()) throw new CliError("Application name cannot be empty.");
  return createAndFetchApp(name.trim());
}
