import { basename } from "node:path";
import { search, confirm } from "@inquirer/prompts";
import { isAgent } from "../../mode.js";
import { getToken } from "../../lib/credential-store.js";
import { login } from "../auth/login.js";
import { listApplications, fetchApplication, type Application } from "../../lib/plapi.js";
import { setProfile, resolveProfile, moveProfile } from "../../lib/config.js";
import { getGitRepoIdentifier, getGitRepoRoot, getGitNormalizedRemote } from "../../lib/git.js";
import { dim, cyan } from "../../lib/color.js";

const AGENT_PROMPT = `You are linking a Clerk application to the current project directory.

## Steps

1. Ensure the user is authenticated. If not, run \`clerk auth login\` first.
2. Determine which application to link:
   - If the user provides an app ID: \`clerk link --app <app_id>\`
   - Otherwise, list available applications with \`GET /v1/platform/applications\` and ask the user to select one.
3. The link is stored in ~/.clerk/config.json as a profile keyed by the git repository root (shared across worktrees).

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /v1/platform/applications | List all applications |
| GET | /v1/platform/applications/{appId} | Fetch application with instance details |`;

interface LinkOptions {
  app?: string;
  skipIfLinked?: boolean;
}

function appLabel(app: Application): string {
  return app.name
    ? `${app.name} (${app.application_id})`
    : app.application_id;
}

export async function link(options: LinkOptions = {}): Promise<void> {
  if (isAgent()) {
    console.log(AGENT_PROMPT);
    return;
  }

  // Resolve git repo identifier — prefer normalized remote URL for cross-clone matching
  const cwd = process.cwd();
  const repoRoot = await getGitRepoRoot();
  const normalizedRemote = await getGitNormalizedRemote();
  const repoId = await getGitRepoIdentifier();
  const profileKey = normalizedRemote ?? repoId ?? cwd;
  const displayPath = repoRoot ?? cwd;

  // Check if already linked
  const existing = await resolveProfile(cwd);
  if (existing) {
    // Print context-specific message
    if (existing.resolvedVia === "remote") {
      console.log(`Auto-linked via git remote (${dim(normalizedRemote ?? existing.path)})`);
    } else {
      console.log(`Already linked to ${cyan(existing.profile.appId)} in ${dim(existing.path)}`);
    }

    if (options.skipIfLinked) return;

    // Offer upgrade when an old profile key can migrate to a remote URL
    if (existing.availableRemote) {
      console.log(`We detected this is now a git repository with remote ${dim(existing.availableRemote)}.`);
      const upgrade = await confirm({
        message: "Update the link to use the git remote? This shares it across clones and worktrees.",
        default: true,
      });
      if (upgrade) {
        await moveProfile(existing.path, existing.availableRemote);
        console.log(`\nLink updated to use git remote (${cyan(existing.availableRemote)})`);
        return;
      }
    }

    const relink = await confirm({ message: "Re-link to a different application?", default: false });
    if (!relink) return;
  }

  // Ensure authenticated
  const token = await getToken();
  if (!token) {
    console.log("Not logged in. Authenticating first...");
    await login();
  }

  // Determine which app to link
  let app: Application;

  if (options.app) {
    app = await fetchApplication(options.app);
  } else {
    const apps = await listApplications();

    if (apps.length === 0) {
      console.error(
        "No applications found. Create one at https://dashboard.clerk.com first.",
      );
      process.exit(1);
    }

    const choices = apps.map((a) => ({
      name: appLabel(a),
      value: a.application_id,
    }));

    const selectedId = await search({
      message: `Select a Clerk application to link ${dim(`(repo: ${basename(displayPath)})`)}`,
      source: (term) => {
        if (!term) return choices;
        const lower = term.toLowerCase();
        return choices.filter((c) => c.name.toLowerCase().includes(lower));
      },
    });

    const found = apps.find((a) => a.application_id === selectedId);
    if (!found) {
      console.error("Selected application not found.");
      process.exit(1);
    }
    app = found;
  }

  const devInstance = app.instances.find(
    (i) => i.environment_type === "development",
  );
  const prodInstance = app.instances.find(
    (i) => i.environment_type === "production",
  );

  if (!devInstance) {
    console.error("Application has no development instance.");
    process.exit(1);
  }

  // Store profile keyed by git repo (or cwd if not in a repo)
  await setProfile(profileKey, {
    workspaceId: "",
    appId: app.application_id,
    instances: {
      development: devInstance.instance_id,
      ...(prodInstance ? { production: prodInstance.instance_id } : {}),
    },
  });

  const label = app.name || app.application_id;
  console.log(`\nLinked to ${cyan(label)} in ${dim(displayPath)}`);
}
