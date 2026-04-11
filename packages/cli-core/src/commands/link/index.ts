import { basename } from "node:path";
import type { Need } from "../../lib/deps.ts";
import { login } from "../auth/login.ts";
import { type Application } from "../../lib/plapi.ts";
import { autolink, findClerkKeys, matchKeyToApp } from "../../lib/autolink.ts";
import { dim, cyan } from "../../lib/color.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";
import { CliError, PlapiError, ERROR_CODE, withApiContext } from "../../lib/errors.ts";

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

export interface LinkOptions {
  app?: string;
  skipIfLinked?: boolean;
}

/**
 * Slice for the public `link` command. Lists every collaborator method this
 * command and its helpers transitively touch (including the nested `login`
 * call when the user is unauthenticated).
 */
export type LinkDeps = Need<{
  credentialStore: "getToken" | "storeToken";
  configStore: "getAuth" | "setAuth" | "resolveProfile" | "setProfile" | "moveProfile";
  git: "getGitRepoRoot" | "getGitRepoIdentifier" | "getGitNormalizedRemote";
  plapi: "fetchApplication" | "listApplications" | "createApplication";
  tokenExchange: "exchangeCodeForToken" | "fetchUserInfo";
  authServer: "startAuthServer";
  pkce: "generateCodeVerifier" | "generateCodeChallenge" | "generateState";
  environment: "getOAuthConfig";
  browser: "open";
  prompts: "confirm" | "search" | "input";
  mode: "isAgent" | "isHuman";
  spinner: "intro" | "outro" | "bar" | "withSpinner";
  log: "info" | "data" | "error";
  env: "get";
}>;

type EnsureAuthDeps = Need<{
  credentialStore: "getToken" | "storeToken";
  configStore: "getAuth" | "setAuth";
  tokenExchange: "exchangeCodeForToken" | "fetchUserInfo";
  authServer: "startAuthServer";
  pkce: "generateCodeVerifier" | "generateCodeChallenge" | "generateState";
  environment: "getOAuthConfig";
  browser: "open";
  prompts: "confirm";
  mode: "isHuman";
  spinner: "intro" | "outro" | "bar" | "withSpinner";
  log: "info";
  env: "get";
}>;

type ResolveAppDeps = Need<{
  plapi: "listApplications" | "fetchApplication" | "createApplication";
  prompts: "confirm" | "search" | "input";
  spinner: "withSpinner";
  log: "info";
}>;

type RunLinkFlowDeps = Need<{
  configStore: "setProfile";
  plapi: "fetchApplication" | "listApplications" | "createApplication";
}> &
  EnsureAuthDeps &
  ResolveAppDeps;

interface LinkContext {
  cwd: string;
  repoRoot: string | undefined;
  normalizedRemote: string | undefined;
  profileKey: string;
  displayPath: string;
}

type GatherContextDeps = Need<{
  git: "getGitRepoRoot" | "getGitRepoIdentifier" | "getGitNormalizedRemote";
}>;

async function gatherContext(deps: GatherContextDeps): Promise<LinkContext> {
  const cwd = process.cwd();
  const repoRoot = await deps.git.getGitRepoRoot();
  const normalizedRemote = await deps.git.getGitNormalizedRemote();
  const repoId = await deps.git.getGitRepoIdentifier();
  const profileKey = normalizedRemote ?? repoId ?? cwd;
  const displayPath = repoRoot ?? cwd;
  return { cwd, repoRoot, normalizedRemote, profileKey, displayPath };
}

function appLabel(app: Application): string {
  return app.name ? `${app.name} (${app.application_id})` : app.application_id;
}

export async function link(deps: LinkDeps, options: LinkOptions = {}): Promise<void> {
  if (deps.mode.isAgent()) {
    deps.log.data(AGENT_PROMPT);
    return;
  }

  const ctx = await gatherContext(deps);
  const existing = await deps.configStore.resolveProfile(ctx.cwd);
  const targetsDifferentApp = options.app && existing && options.app !== existing.profile.appId;

  if (existing && options.skipIfLinked && !targetsDifferentApp) {
    printExistingStatus(deps, existing, ctx.normalizedRemote);
    return;
  }

  if (!existing && options.skipIfLinked && !options.app) {
    const autolinked = await autolink(deps, ctx.cwd);
    if (autolinked) return;
  }

  deps.spinner.intro("clerk link");

  if (existing) {
    const shouldRelink = await handleExistingProfile(deps, existing, ctx.normalizedRemote, options);
    if (!shouldRelink) {
      deps.spinner.outro();
      return;
    }
  }

  await runLinkFlow(deps, options, ctx, !existing);
  deps.spinner.outro(NEXT_STEPS.LINK);
}

async function runLinkFlow(
  deps: RunLinkFlowDeps,
  options: LinkOptions,
  ctx: LinkContext,
  detectKeys: boolean,
): Promise<{ appId: string; appName?: string }> {
  await ensureAuth(deps);

  const app = options.app
    ? await withApiContext(deps.plapi.fetchApplication(options.app), "Failed to fetch application")
    : await resolveApp(deps, ctx.cwd, ctx.displayPath, detectKeys);

  const devInstance = app.instances.find((i) => i.environment_type === "development");
  const prodInstance = app.instances.find((i) => i.environment_type === "production");

  if (!devInstance) {
    throw new CliError("Application has no development instance", {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
    });
  }

  await deps.configStore.setProfile(ctx.profileKey, {
    workspaceId: "",
    appId: app.application_id,
    appName: app.name,
    instances: {
      development: devInstance.instance_id,
      ...(prodInstance ? { production: prodInstance.instance_id } : {}),
    },
  });

  const label = app.name || app.application_id;
  deps.log.info(`Linked to ${cyan(label)} in ${dim(ctx.displayPath)}`);

  return { appId: app.application_id, appName: app.name };
}

async function ensureAuth(deps: EnsureAuthDeps): Promise<void> {
  // CLERK_PLATFORM_API_KEY is a valid non-interactive auth mechanism.
  // The PLAPI fetch helpers use it directly for API calls, so no OAuth
  // token is needed when this key is present.
  if (deps.env.get("CLERK_PLATFORM_API_KEY")) return;
  const token = await deps.credentialStore.getToken();
  if (!token) {
    deps.log.info("Not logged in. Authenticating first...");
    await login(deps, { showNextSteps: false });
  }
}

async function createAndFetchApp(
  deps: Need<{ plapi: "createApplication" | "fetchApplication" }>,
  name: string,
): Promise<Application> {
  const created = await withApiContext(
    deps.plapi.createApplication(name),
    "Failed to create application",
  );
  return withApiContext(
    deps.plapi.fetchApplication(created.application_id),
    "Failed to fetch application",
  );
}

function printExistingStatus(
  deps: Need<{ log: "info" }>,
  existing: NonNullable<Awaited<ReturnType<LinkDeps["configStore"]["resolveProfile"]>>>,
  normalizedRemote: string | undefined,
) {
  if (existing.resolvedVia === "remote") {
    deps.log.info(`Auto-linked via git remote (${dim(normalizedRemote ?? existing.path)})`);
  } else {
    deps.log.info(`Already linked to ${cyan(existing.profile.appId)} in ${dim(existing.path)}`);
  }
}

type HandleExistingProfileDeps = Need<{
  configStore: "moveProfile";
  plapi: "fetchApplication";
  prompts: "confirm";
}> &
  EnsureAuthDeps;

async function handleExistingProfile(
  deps: HandleExistingProfileDeps,
  existing: NonNullable<Awaited<ReturnType<LinkDeps["configStore"]["resolveProfile"]>>>,
  normalizedRemote: string | undefined,
  options: LinkOptions,
): Promise<boolean> {
  printExistingStatus(deps, existing, normalizedRemote);

  if (existing.availableRemote) {
    deps.log.info(
      `We detected this is now a git repository with remote ${dim(existing.availableRemote)}.`,
    );
    const upgrade = await deps.prompts.confirm({
      message: "Update the link to use the git remote? This shares it across clones and worktrees.",
      default: true,
    });
    if (upgrade) {
      await deps.configStore.moveProfile(existing.path, existing.availableRemote);
      deps.log.info(`\nLink updated to use git remote (${cyan(existing.availableRemote)})`);
      return false;
    }
  }

  if (options.app) {
    await ensureAuth(deps);
    const targetApp = await withApiContext(
      deps.plapi.fetchApplication(options.app),
      "Failed to fetch application",
    );
    return deps.prompts.confirm({
      message: `Re-link to ${cyan(appLabel(targetApp))}?`,
      default: false,
    });
  }

  return deps.prompts.confirm({
    message: "Re-link to a different application?",
    default: false,
  });
}

type TryDetectAppDeps = Need<{
  prompts: "confirm";
  log: "info";
}>;

async function tryDetectApp(
  deps: TryDetectAppDeps,
  cwd: string,
  apps: Application[],
): Promise<Application | undefined> {
  const detectedKeys = await findClerkKeys(cwd);
  if (!detectedKeys.length) return undefined;

  const match = matchKeyToApp(detectedKeys, apps);
  if (!match) return undefined;

  deps.log.info(`We found ${cyan(appLabel(match.app))} from ${dim(match.source)}.`);
  const useDetected = await deps.prompts.confirm({
    message: "Link to this application?",
    default: true,
  });
  return useDetected ? match.app : undefined;
}

async function resolveApp(
  deps: ResolveAppDeps,
  cwd: string,
  displayPath: string,
  detectKeys: boolean,
): Promise<Application> {
  let apps: Application[];
  try {
    apps = await deps.spinner.withSpinner("Fetching applications...", () =>
      withApiContext(deps.plapi.listApplications(), "Failed to fetch applications"),
    );
  } catch (error) {
    if (error instanceof PlapiError && error.status >= 500) {
      deps.log.info("Could not fetch your applications, you can still create a new one");
      apps = [];
    } else {
      throw error;
    }
  }

  if (apps.length > 0 && detectKeys) {
    const detected = await tryDetectApp(deps, cwd, apps);
    if (detected) return detected;
  }

  return pickOrCreateApp(deps, apps, displayPath);
}

async function pickOrCreateApp(
  deps: Need<{
    prompts: "search" | "input";
    plapi: "createApplication" | "fetchApplication";
  }>,
  apps: Application[],
  displayPath: string,
): Promise<Application> {
  const appChoices = apps.map((a) => ({ name: appLabel(a), value: a.application_id }));
  const createChoice = { name: dim("+ Create a new application"), value: CREATE_NEW_APP };

  const selectedId = await deps.prompts.search({
    message: `Select a Clerk application to link ${dim(`(repo: ${basename(displayPath)})`)}`,
    source: (term: string | undefined) => {
      const filtered = term
        ? appChoices.filter((c) => c.name.toLowerCase().includes(term.toLowerCase()))
        : appChoices;
      return [...filtered, createChoice];
    },
  });

  if (selectedId === CREATE_NEW_APP) {
    const name = await deps.prompts.input({
      message: "Application name:",
      validate: (v: string) => (v.trim() ? true : "Application name cannot be empty"),
    });
    return createAndFetchApp(deps, name.trim());
  }

  const found = apps.find((a) => a.application_id === selectedId);
  if (!found) {
    throw new CliError("Selected application not found", {
      code: ERROR_CODE.APP_NOT_FOUND,
    });
  }
  return found;
}

// Internal exports used by helpers/link-if-needed.ts. Kept package-private by
// convention; not part of the public command API.
export { runLinkFlow, gatherContext, printExistingStatus };
export type { LinkContext, RunLinkFlowDeps };
