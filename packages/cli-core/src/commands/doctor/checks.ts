import { join } from "node:path";
import { homedir } from "node:os";
import { getConfigFile } from "../../lib/config.ts";
import { fetchUserInfo } from "../../lib/token-exchange.ts";
import { CliError, ERROR_CODE, errorMessage, isAuthError, PlapiError } from "../../lib/errors.ts";
import { detectPublishableKeyName, detectSecretKeyName } from "../../lib/framework.ts";
import { parseEnvFile } from "../../lib/dotenv.ts";
import type { KeylessTarget } from "../../lib/keyless-target.ts";
import { appInNoAccount, unlinkedFolderNextStep } from "../../lib/unlinked-folder.ts";
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
import { CHECK_NAME } from "./types.ts";
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
 * What an unlinked folder with a secret key on disk is running on, and the
 * step to take, from the unlinked-folder module, so `doctor` gives the same
 * advice as every other command. Only an app in no account yet is called
 * unclaimed (`appInNoAccount`): plain keys, or an SDK app whose claim link
 * can't be used, may belong to an app in any account.
 *
 * The step rides in a passing check's message rather than its detail:
 * `detail` only renders under `--verbose`, and guidance nobody sees by
 * default isn't guidance.
 */
async function unlinkedKeyless(
  ctx: DoctorContext,
  keyless: KeylessTarget,
): Promise<{ unclaimedApp?: string; source: string; step: string }> {
  const folder = await ctx.getUnlinkedFolder();
  const step = unlinkedFolderNextStep(folder, { agent: isAgent() }).text;
  const source = `\`${keyless.source}\``;
  if (!appInNoAccount(folder)) return { source, step };
  return { unclaimedApp: keylessLabel(keyless, await ctx.getKeylessInstance()), source, step };
}

/**
 * The file plain keys' secret key comes from, for a check that names what the
 * key runs without giving the step; undefined for an app in no account yet,
 * which is called the accountless application (see `unlinkedKeyless`).
 */
async function plainKeysSource(
  ctx: DoctorContext,
  keyless: KeylessTarget,
): Promise<string | undefined> {
  return appInNoAccount(await ctx.getUnlinkedFolder()) ? undefined : `\`${keyless.source}\``;
}

export async function checkLoggedIn(ctx: DoctorContext): Promise<CheckResult> {
  const check = defineCheck(CHECK_NAME.loggedIn, ctx.fixes.login);

  // Malformed-key detection is a side effect of resolving the keyless target
  // (see getKeylessKeyError), so resolve it before any early return — a
  // Platform API key or stored account token must not hide a broken local
  // CLERK_SECRET_KEY that other commands still prefer over account credentials.
  const keyless = await ctx.getKeylessTarget();
  const keyError = await ctx.getKeylessKeyError();

  if (ctx.hasPlatformAPIKey()) {
    if (keyError) {
      return check.warn(
        `Platform API key configured, but the local secret key is unusable: ${keyError.message}`,
        {
          remedy:
            "Fix or remove the malformed secret key — some commands prefer it over account credentials.",
          fixable: false,
        },
      );
    }
    return check.pass("Platform API key configured");
  }

  // Only consult OAuth credential storage when a Platform API key is not
  // configured. The Platform key is sufficient for Doctor, and an unreadable
  // fallback credential store must not make an otherwise valid setup fail.
  const token = await ctx.getToken();

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

  // No account session doesn't mean the project is broken: a secret key on
  // disk runs the app, an unclaimed accountless one included.
  if (keyless) {
    const { unclaimedApp, source, step } = await unlinkedKeyless(ctx, keyless);
    return check.pass(
      unclaimedApp
        ? `Not logged in — running on the unclaimed accountless application ${unclaimedApp}. ${step}`
        : `Not logged in — this folder uses the secret key from ${source} and isn't linked. ${step}`,
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
  const check = defineCheck(CHECK_NAME.hostExecution);
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
  const check = defineCheck(CHECK_NAME.tokenValid, ctx.fixes.login);
  if (ctx.hasPlatformAPIKey()) {
    try {
      await ctx.verifyAccountAccess();
      return check.pass("Platform API key access verified");
    } catch (error) {
      if (
        isAuthError(error) ||
        (error instanceof CliError && error.code === ERROR_CODE.INVALID_KEY_FORMAT)
      ) {
        return check.fail("Platform API key is invalid or lacks applications:read access", {
          remedy:
            "Replace CLERK_PLATFORM_API_KEY with a valid key that has applications:read access, then rerun `clerk doctor`.",
          fixable: false,
        });
      }
      return check.warn("Could not reach Clerk to verify the Platform API key", {
        detail: errorMessage(error),
        remedy: "Check your network connection and rerun `clerk doctor`.",
        fixable: false,
      });
    }
  }
  const storedToken = await ctx.getToken();
  if (!storedToken) {
    const keyless = await ctx.getKeylessTarget();
    if (!keyless) return check.skip("no token");
    const source = await plainKeysSource(ctx, keyless);
    return check.pass(
      source
        ? `No account session — not required: this folder uses the secret key from ${source}`
        : "No account session — not required for this accountless application",
    );
  }

  try {
    const token = await ctx.getValidToken();
    if (!token) return check.skip("no token");
    const userInfo = await fetchUserInfo(token);
    return check.pass(`Authenticated as ${userInfo.email}`);
  } catch (error) {
    if (isAuthError(error)) {
      // OAuth userinfo isn't available in every environment that accepts the
      // same session through the Platform API. Only a confirmed account read
      // overrides the rejection; anything else keeps the expired result.
      const verified = await ctx.verifyAccountAccess().then(
        () => true,
        () => false,
      );
      if (verified) return check.pass("Account access verified through the Clerk API");

      // Same fallback whoami uses: an expired session doesn't strand a project
      // with a secret key on disk, so don't tell the user their setup is
      // broken. Only an app in no account yet is called accountless (see
      // `unlinkedKeyless`).
      const keyless = await ctx.getKeylessTarget();
      if (keyless) {
        const { unclaimedApp, source } = await unlinkedKeyless(ctx, keyless);
        return unclaimedApp
          ? check.warn(
              `Stored session is expired — falling back to the accountless application ${unclaimedApp}`,
              {
                remedy:
                  "Run `clerk auth login` to re-authenticate your account (optional for accountless work).",
                fixable: false,
              },
            )
          : check.warn(
              `Stored session is expired — falling back to the secret key from ${source}`,
              {
                remedy:
                  "Run `clerk auth login` to re-authenticate your account (optional while this folder uses its own secret key).",
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
  const check = defineCheck(CHECK_NAME.projectLinked, ctx.fixes.link);
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

  // Unlinked isn't automatically broken: a secret key on disk runs the app,
  // and an unclaimed accountless one has nothing to link yet.
  const keyless = await ctx.getKeylessTarget();
  if (keyless) {
    const { unclaimedApp, source, step } = await unlinkedKeyless(ctx, keyless);

    // Someone with an account who hasn't linked this directory *could* reach
    // the full account configuration — say so, unlike the signed-out case.
    // `clerk link` claims an init app first, and finds plain keys' app by key.
    if (await ctx.hasAccountCredentials()) {
      return check.warn(
        unclaimedApp
          ? `Not linked — using the accountless application ${unclaimedApp}, which covers fewer settings`
          : `Not linked — this folder uses the secret key from ${source}`,
        { remedy: step, fixable: true },
      );
    }

    return check.pass(
      unclaimedApp
        ? `Not linked — running on the unclaimed accountless application ${unclaimedApp}. ${step}`
        : `Not linked — this folder uses the secret key from ${source}. ${step}`,
    );
  }

  // No secret key to run on, but the folder may still hold an app (an init
  // token, a publishable key, an SDK file) or an env file it couldn't read.
  return check.fail("Not linked to a Clerk application", {
    remedy: unlinkedFolderNextStep(await ctx.getUnlinkedFolder(), { agent: isAgent() }).text,
  });
}

export async function checkLinkedAppExists(ctx: DoctorContext): Promise<CheckResult> {
  const check = defineCheck(CHECK_NAME.linkedAppExists, ctx.fixes.link);
  if (!(await ctx.hasAccountCredentials())) {
    // This check is account-only — the Platform API application record has no
    // keyless equivalent — so a project running on a secret key has nothing to skip
    // *over*, just nothing to verify.
    const keyless = await ctx.getKeylessTarget();
    if (!keyless) return check.skip("not authenticated");
    const source = await plainKeysSource(ctx, keyless);
    const runs = source ? `secret key from ${source}` : "accountless application";
    return check.skip(`${runs}, no linked app to verify`);
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
  const check = defineCheck(CHECK_NAME.instances, ctx.fixes.link);
  if (!(await ctx.hasAccountCredentials())) {
    // A linked profile's dev/prod instance IDs are an account-only concept —
    // the secret key on disk already addresses its one instance directly.
    const keyless = await ctx.getKeylessTarget();
    if (!keyless) return check.skip("not authenticated");
    const source = await plainKeysSource(ctx, keyless);
    const runs = source ? `secret key from ${source}` : "accountless application";
    return check.skip(`${runs}, no linked instances to verify`);
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
  const check = defineCheck(CHECK_NAME.envVars, ctx.fixes.envPull);
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
  const check = defineCheck(CHECK_NAME.configFile, ctx.fixes.login);
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
  const check = defineCheck(CHECK_NAME.cliVersion);
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
  const check = defineCheck(CHECK_NAME.shellCompletion);
  const shell = detectShell();
  if (!shell) return check.pass("Shell completion (could not detect shell, skipped)");

  const home = process.env.HOME ?? homedir();
  const { isInstalled, remedy } = SHELL_COMPLETION[shell];

  if (await isInstalled(home)) return check.pass(`Shell completion installed for ${shell}`);
  return check.warn(`Shell completion not installed for ${shell}`, { remedy });
}
