import { join } from "node:path";
import { homedir } from "node:os";
import { PlapiError } from "../../lib/errors.ts";
import { detectPublishableKeyName, detectSecretKeyName } from "../../lib/framework.ts";
import { parseEnvFile } from "../../lib/dotenv.ts";
import {
  getCurrentVersion,
  getUpdateChannel,
  isDevVersion,
  compareSemver,
  fetchLatestVersion,
  writeUpdateCache,
  formatChannelFlag,
  formatChannelLabel,
} from "../../lib/update-check.ts";
import { login } from "../auth/login.ts";
import { link } from "../link/index.ts";
import { pullDefault } from "../env/helpers/pull-default.ts";
import type { Root } from "../../lib/deps.ts";
import type { CheckDeps, CheckResult, DoctorContext, FixAction } from "./types.ts";

const AUTH_ERROR_STATUS = /\((401|403)\)/;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Pattern B fix handlers (take Root, dispatch to ported commands) ─────────

const fixLogin = (): FixAction => ({
  label: "Log in with clerk auth login",
  run: async (root: Root) => {
    await login(root);
  },
});

const fixLink = (): FixAction => ({
  label: "Link project with clerk link",
  run: async (root: Root) => {
    await link(root, {});
  },
});

const fixEnvPull = (): FixAction => ({
  label: "Pull env vars with clerk env pull",
  run: async (root: Root) => {
    await pullDefault(root, {});
  },
});

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

export async function checkLoggedIn(_deps: CheckDeps, ctx: DoctorContext): Promise<CheckResult> {
  const check = defineCheck("Logged in", fixLogin);
  const token = await ctx.getToken();
  if (!token) {
    return check.fail("Not logged in", {
      remedy: "Run `clerk auth login` to authenticate.",
    });
  }
  return check.pass("Logged in (token found in credential store)");
}

export async function checkTokenValid(deps: CheckDeps, ctx: DoctorContext): Promise<CheckResult> {
  const check = defineCheck("Authentication valid", fixLogin);
  const token = await ctx.getToken();
  if (!token) return check.skip("no token");

  try {
    const userInfo = await deps.tokenExchange.fetchUserInfo(token);
    return check.pass(`Authenticated as ${userInfo.email}`);
  } catch (error) {
    const message = errorMessage(error);
    if (AUTH_ERROR_STATUS.test(message)) {
      return check.fail("Token is expired or invalid", {
        remedy: "Run `clerk auth login` to re-authenticate.",
      });
    }

    return check.warn("Could not reach Clerk to verify authentication \u2014 network issue", {
      detail:
        "Your stored token from a previous login is likely still valid. " +
        "The auth server was unreachable.",
      remedy:
        "Check your network connection. If issues persist, run `clerk auth login` to re-authenticate.",
    });
  }
}

export async function checkProjectLinked(
  _deps: CheckDeps,
  ctx: DoctorContext,
): Promise<CheckResult> {
  const check = defineCheck("Project linked", fixLink);
  const resolved = await ctx.getProfile();
  if (!resolved) {
    return check.fail("Not linked to a Clerk application", {
      remedy: "Run `clerk link` to associate this project with a Clerk app.",
    });
  }

  const RESOLUTION_LABELS: Record<string, string> = {
    remote: "git remote",
    "git-common-dir": "git repo",
    directory: "directory",
  };
  const via = `via ${RESOLUTION_LABELS[resolved.resolvedVia] ?? resolved.resolvedVia} (${resolved.path})`;

  return check.pass(
    `Linked ${via}`,
    `Workspace: ${resolved.profile.workspaceId || "(none)"}\nDev instance: ${resolved.profile.instances.development}\nProd instance: ${resolved.profile.instances.production ?? "(not set)"}`,
  );
}

export async function checkLinkedAppExists(
  _deps: CheckDeps,
  ctx: DoctorContext,
): Promise<CheckResult> {
  const check = defineCheck("Application reachable", fixLink);
  const token = await ctx.getToken();
  if (!token) return check.skip("not authenticated");

  const resolved = await ctx.getProfile();
  if (!resolved) return check.skip("no project linked");

  try {
    const app = await ctx.getApplication();
    if (!app) return check.skip("could not fetch application");
    const label = app.name || app.application_id;
    return check.pass(`Application "${label}" (${app.application_id}) is reachable`);
  } catch (error) {
    if (error instanceof PlapiError && error.status === 404) {
      return check.fail(`Application ${resolved.profile.appId} not found on Clerk`, {
        remedy:
          "The application doesn't exist or may have been deleted from the Clerk Dashboard. Run `clerk link` to link to a different application, or `clerk unlink` to remove the stale link.",
      });
    }
    return check.fail(`Could not reach Clerk to verify application: ${errorMessage(error)}`, {
      remedy: "Check your network connection and authentication.",
      fixable: false,
    });
  }
}

export async function checkInstances(_deps: CheckDeps, ctx: DoctorContext): Promise<CheckResult> {
  const check = defineCheck("Instance IDs", fixLink);
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

    const parts: string[] = [];
    const stale: string[] = [];

    const classify = (label: string, id: string) => {
      const target = apiInstanceIds.has(id) ? parts : stale;
      target.push(`${label} (${id})`);
    };

    classify("development", devId);
    if (prodId) classify("production", prodId);

    if (stale.length > 0) {
      return check.fail(`Instance ID mismatch: ${stale.join(", ")} not found in application`, {
        remedy:
          "Run `clerk link` to re-link with valid instances, or `clerk unlink` and `clerk link` to start fresh.",
      });
    }

    if (!prodId) {
      return check.warn(`Instance IDs: ${parts.join(", ")} (production not configured)`, {
        detail: "Production instance is optional but recommended for deployment.",
      });
    }

    return check.pass(`Instance IDs: ${parts.join(", ")}`);
  } catch (error) {
    return check.fail(`Could not verify instances: ${errorMessage(error)}`, {
      remedy: "Check your network connection and authentication.",
      fixable: false,
    });
  }
}

async function findEnvFile(
  cwd: string,
): Promise<{ name: string; entries: Record<string, string> } | null> {
  for (const candidate of [".env.local", ".env"]) {
    const file = Bun.file(join(cwd, candidate));
    if (!(await file.exists())) continue;
    const entries: Record<string, string> = {};
    for (const line of parseEnvFile(await file.text())) {
      if (line.type === "entry") entries[line.key] = line.value;
    }
    return { name: candidate, entries };
  }
  return null;
}

export async function checkEnvVars(_deps: CheckDeps, ctx: DoctorContext): Promise<CheckResult> {
  const check = defineCheck("Environment variables", fixEnvPull);
  const cwd = process.cwd();
  const found = await findEnvFile(cwd);

  if (!found) {
    return check.warn("No .env.local or .env file found", {
      remedy: "Run `clerk env pull` to create one with your Clerk keys.",
      fixable: true,
    });
  }

  const { name: foundFile, entries } = found;
  const publishableKeyName = await detectPublishableKeyName(cwd);
  const secretKeyName = await detectSecretKeyName(cwd);
  const hasPublishable = publishableKeyName in entries && entries[publishableKeyName] !== "";
  const hasSecret = secretKeyName in entries && entries[secretKeyName] !== "";

  if (!hasPublishable || !hasSecret) {
    const missing: string[] = [];
    if (!hasPublishable) missing.push(publishableKeyName);
    if (!hasSecret) missing.push(secretKeyName);

    return check.warn(`${foundFile} is missing: ${missing.join(", ")}`, {
      remedy: "Run `clerk env pull` to populate your environment variables.",
      fixable: true,
    });
  }

  const envLabel = await identifyEnvironment(
    ctx,
    entries[publishableKeyName]!,
    entries[secretKeyName]!,
  );

  if (envLabel) {
    return check.pass(
      `${foundFile} contains ${publishableKeyName} and ${secretKeyName} (${envLabel} instance)`,
    );
  }

  return check.pass(`${foundFile} contains ${publishableKeyName} and ${secretKeyName}`);
}

async function identifyEnvironment(
  ctx: DoctorContext,
  publishableKeyValue: string,
  secretKeyValue: string,
): Promise<string | null> {
  const app = await ctx.getApplication().catch(() => null);
  if (!app) return null;

  const match =
    app.instances.find((i) => i.publishable_key === publishableKeyValue) ??
    app.instances.find((i) => i.secret_key === secretKeyValue);
  return match?.environment_type ?? null;
}

export async function checkConfigFile(deps: CheckDeps): Promise<CheckResult> {
  const check = defineCheck("CLI configuration", fixLogin);
  const configFile = getConfigFile(deps);
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
      detail: errorMessage(error),
      remedy: `Check the JSON syntax in ${configFile}, or delete it and re-run \`clerk auth login\`.`,
    });
  }
}

function getConfigFile(deps: CheckDeps): string {
  const homeDir = deps.env.get("CLERK_CONFIG_DIR") ?? join(homedir(), ".clerk");
  return join(homeDir, "config.json");
}

// ── CLI version check ─────────────────────────────────────────────────────────

export async function checkCliVersion(): Promise<CheckResult> {
  const check = defineCheck("CLI version");
  const currentVersion = getCurrentVersion();

  if (isDevVersion(currentVersion)) {
    return check.pass("Running development build");
  }

  const channel = getUpdateChannel();
  const channelLabel = formatChannelLabel(channel);

  const latest = await fetchLatestVersion(channel, 3000).catch(() => null);
  if (!latest) {
    return check.warn("Could not reach npm registry to check for updates", {
      detail: "Check your network connection.",
      fixable: false,
    });
  }

  // Write to cache so the postAction notification fires from cache next time
  await writeUpdateCache({ checkedAt: Date.now(), latest, distTag: channel });

  if (compareSemver(latest, currentVersion) <= 0) {
    return check.pass(`Up to date (${currentVersion}${channelLabel})`);
  }

  return check.warn(`Update available: ${currentVersion} → ${latest}${channelLabel}`, {
    remedy: `Run \`clerk update${formatChannelFlag(channel)}\` to update`,
  });
}

// ── Shell completion check ───────────────────────────────────────────────────

type DetectedShell = "bash" | "zsh" | "fish";

function detectShell(deps: CheckDeps): DetectedShell | null {
  const name = deps.env.get("SHELL")?.split("/").pop();
  if (name === "zsh" || name === "bash" || name === "fish") return name;
  return null;
}

async function fileContains(paths: string[], needle: string): Promise<boolean> {
  for (const path of paths) {
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    if ((await file.text()).includes(needle)) return true;
  }
  return false;
}

const SHELL_COMPLETION: Record<
  DetectedShell,
  {
    isInstalled: (home: string) => Promise<boolean>;
    remedy: string;
  }
> = {
  fish: {
    isInstalled: (home) => Bun.file(join(home, ".config/fish/completions/clerk.fish")).exists(),
    remedy: "Run `clerk completion fish > ~/.config/fish/completions/clerk.fish`",
  },
  bash: {
    isInstalled: (home) =>
      fileContains([join(home, ".bashrc"), join(home, ".bash_profile")], "clerk completion"),
    remedy: 'Add `eval "$(clerk completion bash)"` to your ~/.bashrc',
  },
  zsh: {
    isInstalled: async (home) =>
      (await fileContains([join(home, ".zshrc")], "clerk completion")) ||
      (await Bun.file(join(home, ".zfunc/_clerk")).exists()),
    remedy:
      'Add `eval "$(clerk completion zsh)"` to your ~/.zshrc, or run `clerk completion zsh > ~/.zfunc/_clerk`',
  },
};

export async function checkShellCompletion(deps: CheckDeps): Promise<CheckResult> {
  const check = defineCheck("Shell completion");
  const shell = detectShell(deps);
  if (!shell) return check.pass("Shell completion (could not detect shell, skipped)");

  const home = deps.env.get("HOME") ?? homedir();
  const { isInstalled, remedy } = SHELL_COMPLETION[shell];

  if (await isInstalled(home)) return check.pass(`Shell completion installed for ${shell}`);
  return check.warn(`Shell completion not installed for ${shell}`, { remedy });
}
