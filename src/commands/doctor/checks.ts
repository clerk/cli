import { join } from "node:path";
import { homedir } from "node:os";
import { fetchUserInfo } from "../../lib/token-exchange.ts";
import { PlapiError } from "../../lib/plapi.ts";
import { detectPublishableKeyName } from "../../lib/framework.ts";
import { parseEnvFile } from "../../lib/dotenv.ts";
import type { CheckResult, DoctorContext } from "./types.ts";

// ── Authentication ──────────────────────────────────────────────────────────

export async function checkLoggedIn(ctx: DoctorContext): Promise<CheckResult> {
  const token = await ctx.getToken();
  if (!token) {
    return {
      name: "Authentication token",
      status: "fail",
      message: "Not logged in",
      remedy: "Run `clerk auth login` to authenticate.",
      fix: ctx.fixes.login(),
    };
  }
  return {
    name: "Authentication token",
    status: "pass",
    message: "Token found in credential store",
  };
}

export async function checkTokenValid(ctx: DoctorContext): Promise<CheckResult> {
  const token = await ctx.getToken();
  if (!token) {
    return {
      name: "Token validity",
      status: "warn",
      message: "Skipped (no token)",
    };
  }

  try {
    const userInfo = await fetchUserInfo(token);
    return {
      name: "Token validity",
      status: "pass",
      message: `Authenticated as ${userInfo.email}`,
    };
  } catch (error) {
    const message = (error as Error).message ?? "";
    const isAuthError = /\((401|403)\)/.test(message);

    if (isAuthError) {
      return {
        name: "Token validity",
        status: "fail",
        message: "Token is expired or invalid",
        remedy: "Run `clerk auth login` to re-authenticate.",
        fix: ctx.fixes.login(),
      };
    }

    return {
      name: "Token validity",
      status: "warn",
      message: "Could not verify token — network issue",
      detail:
        "Your stored token from a previous login is likely still valid. " +
        "The auth server was unreachable.",
      remedy:
        "Check your network connection. If issues persist, run `clerk auth login` to re-authenticate.",
    };
  }
}

// ── Project ─────────────────────────────────────────────────────────────────

export async function checkProjectLinked(ctx: DoctorContext): Promise<CheckResult> {
  const resolved = await ctx.getProfile();
  if (!resolved) {
    return {
      name: "Project linkage",
      status: "fail",
      message: "Not linked to a Clerk application",
      remedy: "Run `clerk link` to associate this project with a Clerk app.",
      fix: ctx.fixes.link(),
    };
  }

  const via =
    resolved.resolvedVia === "remote"
      ? `via git remote (${resolved.path})`
      : resolved.resolvedVia === "git-common-dir"
        ? `via git repo (${resolved.path})`
        : `via directory (${resolved.path})`;

  return {
    name: "Project linkage",
    status: "pass",
    message: `Linked to ${resolved.profile.appId} ${via}`,
    detail: `Workspace: ${resolved.profile.workspaceId || "(none)"}\nDev instance: ${resolved.profile.instances.development}\nProd instance: ${resolved.profile.instances.production ?? "(not set)"}`,
  };
}

export async function checkLinkedAppExists(ctx: DoctorContext): Promise<CheckResult> {
  const token = await ctx.getToken();
  if (!token) {
    return {
      name: "Linked app exists",
      status: "warn",
      message: "Skipped (not authenticated)",
    };
  }

  const resolved = await ctx.getProfile();
  if (!resolved) {
    return {
      name: "Linked app exists",
      status: "warn",
      message: "Skipped (no project linked)",
    };
  }

  try {
    const app = await ctx.getApplication();
    if (!app) {
      return {
        name: "Linked app exists",
        status: "warn",
        message: "Skipped (could not fetch application)",
      };
    }
    const label = app.name || app.application_id;
    return {
      name: "Linked app exists",
      status: "pass",
      message: `Application "${label}" is accessible`,
    };
  } catch (error) {
    if (error instanceof PlapiError && error.status === 404) {
      return {
        name: "Linked app exists",
        status: "fail",
        message: `Application ${resolved.profile.appId} not found`,
        remedy:
          "Run `clerk link` to link to a different application, or `clerk unlink` to remove the stale link.",
        fix: ctx.fixes.link(),
      };
    }
    return {
      name: "Linked app exists",
      status: "fail",
      message: `Could not verify application: ${(error as Error).message}`,
      remedy: "Check your network connection and authentication.",
    };
  }
}

export async function checkInstances(ctx: DoctorContext): Promise<CheckResult> {
  const token = await ctx.getToken();
  if (!token) {
    return {
      name: "Instances",
      status: "warn",
      message: "Skipped (not authenticated)",
    };
  }

  const resolved = await ctx.getProfile();
  if (!resolved) {
    return {
      name: "Instances",
      status: "warn",
      message: "Skipped (no project linked)",
    };
  }

  try {
    const app = await ctx.getApplication();
    if (!app) {
      return {
        name: "Instances",
        status: "warn",
        message: "Skipped (could not fetch application)",
      };
    }
    const apiInstanceIds = new Set(app.instances.map((i) => i.instance_id));

    const devId = resolved.profile.instances.development;
    const prodId = resolved.profile.instances.production;

    const devValid = apiInstanceIds.has(devId);
    const prodValid = prodId ? apiInstanceIds.has(prodId) : undefined;

    const parts: string[] = [];
    const stale: string[] = [];

    if (devValid) {
      parts.push(`development (${devId})`);
    } else {
      stale.push(`development (${devId})`);
    }

    if (prodId) {
      if (prodValid) {
        parts.push(`production (${prodId})`);
      } else {
        stale.push(`production (${prodId})`);
      }
    }

    if (stale.length > 0) {
      return {
        name: "Instances",
        status: "fail",
        message: `Stale instance ID: ${stale.join(", ")}`,
        remedy:
          "Run `clerk link` to re-link with valid instances, or `clerk unlink` and `clerk link` to start fresh.",
        fix: ctx.fixes.link(),
      };
    }

    if (!prodId) {
      return {
        name: "Instances",
        status: "warn",
        message: `Instances: ${parts.join(", ")} (production not configured)`,
        detail: "Production instance is optional but recommended for deployment.",
      };
    }

    return {
      name: "Instances",
      status: "pass",
      message: `Instances: ${parts.join(", ")}`,
    };
  } catch (error) {
    return {
      name: "Instances",
      status: "fail",
      message: `Could not verify instances: ${(error as Error).message}`,
      remedy: "Check your network connection and authentication.",
    };
  }
}

// ── Environment ─────────────────────────────────────────────────────────────

export async function checkGitAvailable(_ctx: DoctorContext): Promise<CheckResult> {
  try {
    const result = await Bun.$`git --version`.quiet().nothrow();
    if (result.exitCode !== 0) {
      return {
        name: "Git",
        status: "warn",
        message: "Git is not available",
        remedy: "Install git to enable repository-based project linking.",
      };
    }
    return {
      name: "Git",
      status: "pass",
      message: result.text().trim(),
    };
  } catch {
    return {
      name: "Git",
      status: "warn",
      message: "Git is not available",
      remedy: "Install git to enable repository-based project linking.",
    };
  }
}

export async function checkEnvVars(ctx: DoctorContext): Promise<CheckResult> {
  const cwd = process.cwd();

  const candidates = [".env.local", ".env"];
  let foundFile: string | undefined;
  const entries: Record<string, string> = {};

  for (const name of candidates) {
    const filePath = join(cwd, name);
    const file = Bun.file(filePath);
    if (await file.exists()) {
      foundFile = name;
      const content = await file.text();
      const lines = parseEnvFile(content);
      for (const line of lines) {
        if (line.type === "entry") {
          entries[line.key] = line.value;
        }
      }
      break;
    }
  }

  if (!foundFile) {
    return {
      name: "Environment variables",
      status: "warn",
      message: "No .env.local or .env file found",
      remedy: "Run `clerk env pull` to create one with your Clerk keys.",
      fix: ctx.fixes.envPull(),
    };
  }

  const publishableKeyName = await detectPublishableKeyName(cwd);
  const hasPublishable = publishableKeyName in entries && entries[publishableKeyName] !== "";
  const hasSecret = "CLERK_SECRET_KEY" in entries && entries["CLERK_SECRET_KEY"] !== "";

  if (!hasPublishable || !hasSecret) {
    const missing: string[] = [];
    if (!hasPublishable) missing.push(publishableKeyName);
    if (!hasSecret) missing.push("CLERK_SECRET_KEY");

    return {
      name: "Environment variables",
      status: "warn",
      message: `${foundFile} is missing: ${missing.join(", ")}`,
      remedy: "Run `clerk env pull` to populate your environment variables.",
      fix: ctx.fixes.envPull(),
    };
  }

  const envLabel = await identifyEnvironment(
    ctx,
    entries[publishableKeyName]!,
    entries["CLERK_SECRET_KEY"]!,
  );

  if (envLabel) {
    return {
      name: "Environment variables",
      status: "pass",
      message: `${foundFile} contains ${publishableKeyName} and CLERK_SECRET_KEY (${envLabel} instance)`,
    };
  }

  return {
    name: "Environment variables",
    status: "pass",
    message: `${foundFile} contains ${publishableKeyName} and CLERK_SECRET_KEY`,
  };
}

/** Match the publishable key or secret key against the linked app's instances to identify the environment. */
async function identifyEnvironment(
  ctx: DoctorContext,
  publishableKeyValue: string,
  secretKeyValue: string,
): Promise<string | null> {
  let app;
  try {
    app = await ctx.getApplication();
  } catch {
    return null;
  }
  if (!app) return null;

  const match =
    app.instances.find((i) => i.publishable_key === publishableKeyValue) ??
    app.instances.find((i) => i.secret_key === secretKeyValue);
  return match?.environment_type ?? null;
}

// ── Configuration ───────────────────────────────────────────────────────────

export async function checkConfigFile(ctx: DoctorContext): Promise<CheckResult> {
  const configFile = getConfigFile();
  const file = Bun.file(configFile);
  if (!(await file.exists())) {
    return {
      name: "CLI configuration",
      status: "warn",
      message: `${configFile} does not exist`,
      detail: "The config file is created when you first run `clerk auth login` or `clerk link`.",
      remedy: "Run `clerk auth login` to initialize the CLI.",
      fix: ctx.fixes.login(),
    };
  }

  try {
    const config = (await file.json()) as {
      profiles?: Record<string, unknown>;
      auth?: unknown;
    };
    const profileCount = Object.keys(config.profiles ?? {}).length;
    const hasAuth = !!config.auth;
    return {
      name: "CLI configuration",
      status: "pass",
      message: `${configFile} is valid (${profileCount} profile${profileCount !== 1 ? "s" : ""}, auth: ${hasAuth ? "yes" : "no"})`,
    };
  } catch (error) {
    return {
      name: "CLI configuration",
      status: "fail",
      message: `${configFile} failed to parse`,
      detail: (error as Error).message,
      remedy: `Check the JSON syntax in ${configFile}, or delete it and re-run \`clerk auth login\`.`,
      fix: ctx.fixes.login(),
    };
  }
}

function getConfigFile(): string {
  const homeDir = process.env.CLERK_CONFIG_DIR ?? join(homedir(), ".clerk");
  return join(homeDir, "config.json");
}
