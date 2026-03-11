import { join } from "node:path";
import { homedir } from "node:os";
import { fetchUserInfo } from "../../lib/token-exchange.ts";
import { PlapiError } from "../../lib/plapi.ts";
import { detectPublishableKeyName } from "../../lib/framework.ts";
import { parseEnvFile } from "../../lib/dotenv.ts";
import type { CheckResult, DoctorContext, FixAction } from "./types.ts";

const AUTH_ERROR_STATUS = /\((401|403)\)/;

interface CheckOptions {
  remedy?: string;
  detail?: string;
  fixable?: boolean;
}

interface CheckBuilder {
  pass(message: string, detail?: string): CheckResult;
  fail(message: string, opts?: CheckOptions): CheckResult;
  warn(message: string, opts?: CheckOptions): CheckResult;
  skip(reason: string): CheckResult;
}

function defineCheck(name: string, fixFactory?: () => FixAction): CheckBuilder {
  function buildResult(
    status: "fail" | "warn",
    message: string,
    opts: CheckOptions | undefined,
    fixableByDefault: boolean,
  ): CheckResult {
    const { remedy, detail, fixable = fixableByDefault } = opts ?? {};
    return {
      name,
      status,
      message,
      ...(detail && { detail }),
      ...(remedy && { remedy }),
      ...(fixable && fixFactory && { fix: fixFactory() }),
    };
  }

  return {
    pass(message, detail) {
      return { name, status: "pass", message, ...(detail && { detail }) };
    },
    fail(message, opts) {
      return buildResult("fail", message, opts, true);
    },
    warn(message, opts) {
      return buildResult("warn", message, opts, false);
    },
    skip(reason) {
      return { name, status: "warn", message: `Skipped (${reason})` };
    },
  };
}

export async function checkLoggedIn(ctx: DoctorContext): Promise<CheckResult> {
  const check = defineCheck("Authentication token", ctx.fixes.login);
  const token = await ctx.getToken();
  if (!token) {
    return check.fail("Not logged in", {
      remedy: "Run `clerk auth login` to authenticate.",
    });
  }
  return check.pass("Token found in credential store");
}

export async function checkTokenValid(ctx: DoctorContext): Promise<CheckResult> {
  const check = defineCheck("Token validity", ctx.fixes.login);
  const token = await ctx.getToken();
  if (!token) return check.skip("no token");

  try {
    const userInfo = await fetchUserInfo(token);
    return check.pass(`Authenticated as ${userInfo.email}`);
  } catch (error) {
    const message = (error as Error).message ?? "";
    if (AUTH_ERROR_STATUS.test(message)) {
      return check.fail("Token is expired or invalid", {
        remedy: "Run `clerk auth login` to re-authenticate.",
      });
    }

    return check.warn("Could not verify token — network issue", {
      detail:
        "Your stored token from a previous login is likely still valid. " +
        "The auth server was unreachable.",
      remedy:
        "Check your network connection. If issues persist, run `clerk auth login` to re-authenticate.",
    });
  }
}

export async function checkProjectLinked(ctx: DoctorContext): Promise<CheckResult> {
  const check = defineCheck("Project linkage", ctx.fixes.link);
  const resolved = await ctx.getProfile();
  if (!resolved) {
    return check.fail("Not linked to a Clerk application", {
      remedy: "Run `clerk link` to associate this project with a Clerk app.",
    });
  }

  const via =
    resolved.resolvedVia === "remote"
      ? `via git remote (${resolved.path})`
      : resolved.resolvedVia === "git-common-dir"
        ? `via git repo (${resolved.path})`
        : `via directory (${resolved.path})`;

  return check.pass(
    `Linked to ${resolved.profile.appId} ${via}`,
    `Workspace: ${resolved.profile.workspaceId || "(none)"}\nDev instance: ${resolved.profile.instances.development}\nProd instance: ${resolved.profile.instances.production ?? "(not set)"}`,
  );
}

export async function checkLinkedAppExists(ctx: DoctorContext): Promise<CheckResult> {
  const check = defineCheck("Linked application", ctx.fixes.link);
  const token = await ctx.getToken();
  if (!token) return check.skip("not authenticated");

  const resolved = await ctx.getProfile();
  if (!resolved) return check.skip("no project linked");

  try {
    const app = await ctx.getApplication();
    if (!app) return check.skip("could not fetch application");
    const label = app.name || app.application_id;
    return check.pass(`Application "${label}" is accessible`);
  } catch (error) {
    if (error instanceof PlapiError && error.status === 404) {
      return check.fail(`Application ${resolved.profile.appId} not found`, {
        remedy:
          "Run `clerk link` to link to a different application, or `clerk unlink` to remove the stale link.",
      });
    }
    return check.fail(`Could not verify application: ${(error as Error).message}`, {
      remedy: "Check your network connection and authentication.",
      fixable: false,
    });
  }
}

export async function checkInstances(ctx: DoctorContext): Promise<CheckResult> {
  const check = defineCheck("Instances", ctx.fixes.link);
  const token = await ctx.getToken();
  if (!token) return check.skip("not authenticated");

  const resolved = await ctx.getProfile();
  if (!resolved) return check.skip("no project linked");

  try {
    const app = await ctx.getApplication();
    if (!app) return check.skip("could not fetch application");
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
      return check.fail(`Stale instance ID: ${stale.join(", ")}`, {
        remedy:
          "Run `clerk link` to re-link with valid instances, or `clerk unlink` and `clerk link` to start fresh.",
      });
    }

    if (!prodId) {
      return check.warn(`Instances: ${parts.join(", ")} (production not configured)`, {
        detail: "Production instance is optional but recommended for deployment.",
      });
    }

    return check.pass(`Instances: ${parts.join(", ")}`);
  } catch (error) {
    return check.fail(`Could not verify instances: ${(error as Error).message}`, {
      remedy: "Check your network connection and authentication.",
      fixable: false,
    });
  }
}

export async function checkEnvVars(ctx: DoctorContext): Promise<CheckResult> {
  const check = defineCheck("Environment variables", ctx.fixes.envPull);
  const cwd = process.cwd();

  const candidates = [".env.local", ".env"];
  let foundFile: string | undefined;
  const entries: Record<string, string> = {};

  for (const candidate of candidates) {
    const filePath = join(cwd, candidate);
    const file = Bun.file(filePath);
    if (await file.exists()) {
      foundFile = candidate;
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
    return check.warn("No .env.local or .env file found", {
      remedy: "Run `clerk env pull` to create one with your Clerk keys.",
      fixable: true,
    });
  }

  const publishableKeyName = await detectPublishableKeyName(cwd);
  const hasPublishable = publishableKeyName in entries && entries[publishableKeyName] !== "";
  const hasSecret = "CLERK_SECRET_KEY" in entries && entries["CLERK_SECRET_KEY"] !== "";

  if (!hasPublishable || !hasSecret) {
    const missing: string[] = [];
    if (!hasPublishable) missing.push(publishableKeyName);
    if (!hasSecret) missing.push("CLERK_SECRET_KEY");

    return check.warn(`${foundFile} is missing: ${missing.join(", ")}`, {
      remedy: "Run `clerk env pull` to populate your environment variables.",
      fixable: true,
    });
  }

  const envLabel = await identifyEnvironment(
    ctx,
    entries[publishableKeyName]!,
    entries["CLERK_SECRET_KEY"]!,
  );

  if (envLabel) {
    return check.pass(
      `${foundFile} contains ${publishableKeyName} and CLERK_SECRET_KEY (${envLabel} instance)`,
    );
  }

  return check.pass(`${foundFile} contains ${publishableKeyName} and CLERK_SECRET_KEY`);
}

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

export async function checkConfigFile(ctx: DoctorContext): Promise<CheckResult> {
  const check = defineCheck("CLI configuration", ctx.fixes.login);
  const configFile = getConfigFile();
  const file = Bun.file(configFile);
  if (!(await file.exists())) {
    return check.warn(`${configFile} does not exist`, {
      detail: "The config file is created when you first run `clerk auth login` or `clerk link`.",
      remedy: "Run `clerk auth login` to initialize the CLI.",
      fixable: true,
    });
  }

  try {
    const config = (await file.json()) as {
      profiles?: Record<string, unknown>;
      auth?: unknown;
    };
    const profileCount = Object.keys(config.profiles ?? {}).length;
    const hasAuth = !!config.auth;
    return check.pass(
      `${configFile} is valid (${profileCount} profile${profileCount !== 1 ? "s" : ""}, auth: ${hasAuth ? "yes" : "no"})`,
    );
  } catch (error) {
    return check.fail(`${configFile} failed to parse`, {
      detail: (error as Error).message,
      remedy: `Check the JSON syntax in ${configFile}, or delete it and re-run \`clerk auth login\`.`,
    });
  }
}

function getConfigFile(): string {
  const homeDir = process.env.CLERK_CONFIG_DIR ?? join(homedir(), ".clerk");
  return join(homeDir, "config.json");
}
