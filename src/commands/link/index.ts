import { basename } from "node:path";
import { search, confirm } from "@inquirer/prompts";
import { isHuman } from "../../mode.js";
import { getToken } from "../../lib/credential-store.js";
import { login } from "../auth/login.js";
import { listApplications, fetchApplication, type Application } from "../../lib/plapi.js";
import { setProfile, resolveProfile, moveProfile } from "../../lib/config.js";
import { getGitRepoIdentifier, getGitRepoRoot, getGitNormalizedRemote } from "../../lib/git.js";
import { dim } from "../../lib/color.js";
import { createCommandOutput } from "../../lib/cli.js";
import { CliError } from "../../lib/errors.js";

interface LinkOptions {
  app?: string;
  skipIfLinked?: boolean;
}

function appLabel(app: Application): string {
  return app.name ? `${app.name} (${app.application_id})` : app.application_id;
}

export async function link(options: LinkOptions = {}): Promise<void> {
  using out = createCommandOutput("link");

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
    out.add("already_linked", true, `Already linked to ${existing.profile.appId}`);

    if (options.skipIfLinked) return;

    if (isHuman()) {
      // Print context-specific message
      if (existing.resolvedVia === "remote") {
        console.log(`  Auto-linked via git remote (${dim(normalizedRemote ?? existing.path)})`);
      }

      // Offer upgrade when an old profile key can migrate to a remote URL
      if (existing.availableRemote) {
        console.log(
          `  We detected this is now a git repository with remote ${dim(existing.availableRemote)}.`,
        );
        const upgrade = await confirm({
          message:
            "Update the link to use the git remote? This shares it across clones and worktrees.",
          default: true,
        });
        if (upgrade) {
          await moveProfile(existing.path, existing.availableRemote);
          out.add("upgraded", true, `Link updated to use git remote (${existing.availableRemote})`);
          return;
        }
      }

      const relink = await confirm({
        message: "Re-link to a different application?",
        default: false,
      });
      if (!relink) return;
    } else {
      // Agent: already linked, suggest re-link with --app if needed
      out.suggest(`clerk link --app <app_id>`);
      return;
    }
  }

  // Check auth
  const token = await getToken();
  if (!token) {
    if (isHuman()) {
      console.log("  Not logged in. Authenticating first...");
      await login();
      out.add("authenticated", true, "Logged in");
    } else {
      out.add("authenticated", false, "Not logged in", "clerk auth login");
      return;
    }
  } else {
    out.add("authenticated", true, "Logged in");
  }

  // Determine which app to link
  let app: Application;

  if (options.app) {
    app = await fetchApplication(options.app);
  } else {
    const apps = await listApplications();

    if (apps.length === 0) {
      if (isHuman()) {
        throw new CliError("No applications found. Create one at https://dashboard.clerk.com");
      }
      out.add(
        "applications",
        false,
        "No applications found",
        "Create one at https://dashboard.clerk.com",
      );
      return;
    }

    if (isHuman()) {
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
        throw new CliError("Selected application not found.");
      }
      app = found;
    } else {
      // Agent can't pick interactively — list available apps with names
      const appList = apps.map((a) => `${appLabel(a)}`).join(", ");
      out.add("applications", true, `${apps.length} available: ${appList}`);
      out.suggest("clerk link --app <app_id> (pick one from above)");
      return;
    }
  }

  const devInstance = app.instances.find((i) => i.environment_type === "development");
  const prodInstance = app.instances.find((i) => i.environment_type === "production");

  if (!devInstance) {
    if (isHuman()) {
      throw new CliError("Application has no development instance.");
    }
    out.add("instance", false, "Application has no development instance");
    return;
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
  out.add("linked", true, `Linked to ${label} in ${displayPath}`);
}
