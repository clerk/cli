import { basename } from "node:path";
import { select, confirm } from "@inquirer/prompts";
import { isAgent } from "../../mode.js";
import { getToken } from "../../lib/credential-store.js";
import { login } from "../auth/login.js";
import { listApplications, fetchApplication, type Application } from "../../lib/plapi.js";
import { setProfile, resolveProfile } from "../../lib/config.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

const AGENT_PROMPT = `You are linking a Clerk application to the current project directory.

## Steps

1. Ensure the user is authenticated. If not, run \`clerk auth login\` first.
2. Determine which application to link:
   - If the user provides an app ID: \`clerk link --app <app_id>\`
   - Otherwise, list available applications with \`GET /v1/platform/applications\` and ask the user to select one.
3. The link is stored in ~/.clerk/config.json as a profile keyed by the current directory path.

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /v1/platform/applications | List all applications |
| GET | /v1/platform/applications/{appId} | Fetch application with instance details |`;

interface LinkOptions {
  app?: string;
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

  // Check if already linked
  const cwd = process.cwd();
  const existing = await resolveProfile(cwd);
  if (existing && existing.path === cwd) {
    console.log(`Already linked to ${cyan(existing.profile.appId)} in ${dim(cwd)}`);
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

    const selectedId = await select({
      message: `Select a Clerk application to link ${dim(`(dir: /${basename(process.cwd())})`)}`,
      choices: apps.map((a) => ({
        name: appLabel(a),
        value: a.application_id,
      })),
    });

    app = apps.find((a) => a.application_id === selectedId)!;
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

  // Store profile
  await setProfile(cwd, {
    workspaceId: "",
    appId: app.application_id,
    instances: {
      development: devInstance.instance_id,
      ...(prodInstance ? { production: prodInstance.instance_id } : {}),
    },
  });

  const label = app.name || app.application_id;
  console.log(`\nLinked to ${cyan(label)} in ${dim(cwd)}`);
}
