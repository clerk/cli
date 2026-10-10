import { join } from "node:path";
import { homedir } from "node:os";
import { getConfigFile } from "../../lib/config.ts";
import { fetchUserInfo } from "../../lib/token-exchange.ts";
import { errorMessage, isAuthError, PlapiError } from "../../lib/errors.ts";
import { detectPublishableKeyName, detectSecretKeyName } from "../../lib/framework.ts";
import { parseEnvFile } from "../../lib/dotenv.ts";
import { hasAccountCredentials } from "../../lib/credential-store.ts";
import type { KeylessTarget } from "../../lib/keyless-target.ts";
import { CURRENT_VERSION, IS_DEV_BUILD } from "../../lib/version.ts";
import {
  getUpdateChannel,
  compareSemver,
  fetchLatestVersion,
  writeUpdateCache,
  formatChannelFlag,
  formatChannelLabel,
} from "../../lib/update-check.ts";
import { formatHostStateProbeFailures, getAgentHostStateProbe } from "../../lib/host-execution.ts";
import { isAgent } from "../../mode.ts";
import type { CheckResult, DoctorContext, FixAction, KeylessInstanceInfo } from "./types.ts";

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

/** How to refer to an unclaimed accountless application in check output. */
function keylessLabel(keyless: KeylessTarget, instance: KeylessInstanceInfo | null): string {
  const name = instance?.id ? `\`${instance.id}\`` : "this application";
  const env = instance?.environmentType ? ` (${instance.environmentType})` : "";
  return `${name}${env} — secret key from \`${keyless.source}\``;
}

/**
 * How this particular application can be claimed, which is not one answer.
 * `clerk auth login` only claims silently when `clerk init` left a claim token
 * behind; a key that arrived any other way (an SDK's own keyless.json, a
 * hand-copied secret) has no token to redeem and has to be claimed from the
 * dashboard instead.
 *
 * This rides in the check's message rather than its detail: `detail` only
 * renders under `--verbose`, and guidance nobody sees by default isn't
 * guidance.
 */
async function claimHint(ctx: DoctorContext): Promise<string> {
  return (await ctx.hasClaimBreadcrumb())
    ? "Run `clerk auth login` to claim it."
    : "Claim it from the Clerk Dashboard — `clerk auth login` only claims applications `clerk init` created.";
}

export async function checkLoggedIn(ctx: DoctorContext): Promise<CheckResult> {
  const check = defineCheck("Logged in", ctx.fixes.login);
  const token = await ctx.getToken();

  // Malformed-key detection is a side effect of resolving the keyless target
  // (see getKeylessKeyError), so resolve it before any early return — a
  // stored account token must not hide a broken local CLERK_SECRET_KEY that
  // other commands still prefer over the account session.
  const keyless = await ctx.getKeylessTarget();
  const keyError = await ctx.getKeylessKeyError();

  if (token) {
    if (keyError) {
      return check.warn(`Logged in, but the local secret key is unusable: ${keyError.message}`, {
        remedy:
          "Fix or remove the malformed key — some commands prefer it over your account session.",
        fixable: false,
      });
    }
    return check.pass("Logged in (token found in credential store)");
  }

  // No account session doesn't mean the project is broken: an unclaimed
  // accountless application is a legitimate, healthy way to run the CLI.
  if (keyless) {
    const instance = await ctx.getKeylessInstance();
    return check.pass(
      `Not logged in — running on the unclaimed accountless application ${keylessLabel(keyless, instance)}. ${await claimHint(ctx)}`,
    );
  }

  // A local key that isn't a secret key at all is the one keyless state that
  // is genuinely broken — report it here as the named diagnosis, once, rather
  // than letting it crash every keyless-aware check (see getKeylessKeyError).
  if (keyError) {
    return check.fail(`Not logged in, and the local secret key is unusable: ${keyError.message}`, {
      remedy: "Fix or remove the malformed key, or run `clerk auth login` to authenticate.",
      fixable: false,
    });
  }

  return check.fail("Not logged in", {
    remedy: "Run `clerk auth login` to authenticate.",
  });
}

export async function checkHostExecution(): Promise<CheckResult> {
  const check = defineCheck("Host execution");
  if (!isAgent()) {
    return check.pass("Skipped (human mode)");
  }

  const probe = await getAgentHostStateProbe();
  if (probe.ok) {
    return check.pass("Host-only Clerk state is writable in agent mode");
  }

  return check.warn("Host-only Clerk state is not writable in agent mode", {
    detail: formatHostStateProbeFailures(probe.failures),
    remedy:
      "This may be a sandboxed run. Re-run the command on the host shell before trusting auth, link, env, or API failures.",
    fixable: false,
  });
}

export async function checkTokenValid(ctx: DoctorContext): Promise<CheckResult> {
  const check = defineCheck("Authentication valid", ctx.fixes.login);
  const storedToken = await ctx.getToken();
  if (!storedToken) {
    const keyless = await ctx.getKeylessTarget();
    return keyless
      ? check.pass("No account session — not required for this accountless application")
      : check.skip("no token");
  }

  try {
    const token = await ctx.getValidToken();
    if (!token) return check.skip("no token");
    const userInfo = await fetchUserInfo(token);
    return check.pass(`Authenticated as ${userInfo.email}`);
  } catch (error) {
    if (isAuthError(error)) {
      // Same fallback whoami uses: an expired session doesn't strand a keyless
      // project, so don't tell the user their setup is broken.
      const keyless = await ctx.getKeylessTarget();
      if (keyless) {
        const instance = await ctx.getKeylessInstance();
        return check.warn(
          `Stored session is expired — falling back to the accountless application ${keylessLabel(keyless, instance)}`,
          {
            remedy:
              "Run `clerk auth login` to re-authenticate your account (optional for accountless work).",
            fixable: false,
          },
        );
      }

      return check.fail("Token is expired or invalid", {
        remedy: "Run `clerk auth login` to re-authenticate.",
      });
    }

    return check.warn("Could not reach Clerk to verify authentication — network issue", {
      detail:
        "Your stored token from a previous login is likely still valid. " +
        "The auth server was unreachable.",
      remedy:
        "Check your network connection. If issues persist, run `clerk auth login` to re-authenticate.",
    });
  }
}

export async function checkProjectLinked(ctx: DoctorContext): Promise<CheckResult> {
  const check = defineCheck("Project linked", ctx.fixes.link);
  const resolved = await ctx.getProfile();
  if (resolved) {
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

  // Unlinked isn't automatically broken: a project running on an unclaimed
  // accountless application has nothing to link yet.
  const keyless = await ctx.getKeylessTarget();
  if (keyless) {
    const instance = await ctx.getKeylessInstance();
    const label = keylessLabel(keyless, instance);

    // Someone with an account who hasn't linked this directory *could* reach
    // the full account configuration — say so, unlike the fully unclaimed case.
    if (await hasAccountCredentials()) {
      return check.warn(
        `Not linked — using the accountless application ${label}, which covers fewer settings`,
        {
          remedy: "Run `clerk link` to use the full account configuration.",
          fixable: true,
        },
      );
    }

    return check.pass(
      `Not linked — running on the unclaimed accountless application ${label}. ${await claimHint(ctx)}`,
    );
  }

  return check.fail("Not linked to a Clerk application", {
    remedy: "Run `clerk link` to associate this project with a Clerk app.",
  });
}

export async function checkLinkedAppExists(ctx: DoctorContext): Promise<CheckResult> {
  const check = defineCheck("Application reachable", ctx.fixes.link);
  const token = await ctx.getToken();
  if (!token) {
    // This check is account-only — the Platform API application record has no
    // keyless equivalent — so an unclaimed keyless project has nothing to skip
    // *over*, just nothing to verify.
    const keyless = await ctx.getKeylessTarget();
    return check.skip(
      keyless ? "accountless application, no linked app to verify" : "not authenticated",
    );
  }

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

export async function checkInstances(ctx: DoctorContext): Promise<CheckResult> {
  const check = defineCheck("Instance IDs", ctx.fixes.link);
  const token = await ctx.getToken();
  if (!token) {
    // A linked profile's dev/prod instance IDs are an account-only concept —
    // the secret key on disk already addresses its one instance directly.
    const keyless = await ctx.getKeylessTarget();
    return check.skip(
      keyless ? "accountless application, no linked instances to verify" : "not authenticated",
    );
  }

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

export async function checkEnvVars(ctx: DoctorContext): Promise<CheckResult> {
  const check = defineCheck("Environment variables", ctx.fixes.envPull);
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
      detail: errorMessage(error),
      remedy: `Check the JSON syntax in ${configFile}, or delete it and re-run \`clerk auth login\`.`,
    });
  }
}

// ── CLI version check ─────────────────────────────────────────────────────────

export async function checkCliVersion(): Promise<CheckResult> {
  const check = defineCheck("CLI version");
  if (IS_DEV_BUILD) {
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

  if (compareSemver(latest, CURRENT_VERSION) <= 0) {
    return check.pass(`Up to date (${CURRENT_VERSION}${channelLabel})`);
  }

  return check.warn(`Update available: ${CURRENT_VERSION} → ${latest}${channelLabel}`, {
    remedy: `Run \`clerk update${formatChannelFlag(channel)}\` to update`,
  });
}

// ── Shell completion check ───────────────────────────────────────────────────

type DetectedShell = "bash" | "zsh" | "fish";

function detectShell(): DetectedShell | null {
  // FISH_VERSION is set by fish itself, so it's a stronger signal than $SHELL — which only reflects
  // the login shell and won't follow an interactive `chsh`-less switch into fish.
  if (process.env.FISH_VERSION) return "fish";
  const name = process.env.SHELL?.split("/").pop();
  if (name === "bash" || name === "zsh" || name === "fish") return name;
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
    isInstalled: async (home) =>
      Bun.file(join(home, ".config/fish/completions/clerk.fish")).exists(),
    remedy:
      "Run `mkdir -p ~/.config/fish/completions && clerk completion fish > ~/.config/fish/completions/clerk.fish`",
  },
  bash: {
    isInstalled: async (home) =>
      fileContains([join(home, ".bashrc"), join(home, ".bash_profile")], "clerk completion"),
    remedy: 'Add `eval "$(clerk completion bash)"` to your ~/.bashrc',
  },
  zsh: {
    isInstalled: async (home) =>
      (await fileContains([join(home, ".zshrc")], "clerk completion")) ||
      (await Bun.file(join(home, ".zfunc/_clerk")).exists()),
    remedy:
      'Add `eval "$(clerk completion zsh)"` to your ~/.zshrc (run `clerk completion --help` for other install methods)',
  },
};

export async function checkShellCompletion(): Promise<CheckResult> {
  const check = defineCheck("Shell completion");
  const shell = detectShell();
  if (!shell) return check.pass("Shell completion (could not detect shell, skipped)");

  const home = process.env.HOME ?? homedir();
  const { isInstalled, remedy } = SHELL_COMPLETION[shell];

  if (await isInstalled(home)) return check.pass(`Shell completion installed for ${shell}`);
  return check.warn(`Shell completion not installed for ${shell}`, { remedy });
}
