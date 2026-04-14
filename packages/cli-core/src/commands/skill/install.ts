/**
 * `clerk skill install` — installs the bundled `clerk` skill for local
 * agents.
 *
 * The `clerk` skill is embedded in the CLI binary via text imports at
 * compile time. At install time we stage it to a temp dir and invoke
 * `skills add <tmpdir> --copy`, so the installed files are full copies
 * (not symlinks into the temp dir, which would break when cleaned up).
 *
 * The external `skills` CLI handles agent auto-detection and scope
 * selection: in interactive mode we hand off entirely (no `--agent` / `-y`),
 * so the user gets the native picker. In non-interactive mode we pass
 * `-y -g` so it runs unattended with global scope and auto-detected agents.
 *
 * The `init` command also imports `installClerkSkillCore` and
 * `resolveSkillsRunner` from here so a single runner detection is shared
 * with the upstream framework-pattern skills install.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { dim } from "../../lib/color.js";
import { isHuman } from "../../mode.js";
import { log } from "../../lib/log.js";
import { DEV_CLI_VERSION, resolveCliVersion } from "../../lib/version.js";
import { select } from "../../lib/listage.js";
import {
  type Runner,
  detectAvailableRunners,
  preferredRunner,
  runnerCommand,
  runnerForPackageManager,
} from "../../lib/runners.js";
import { isNonEmpty } from "../../lib/helpers/arrays.js";
import { detectPackageManager, type PackageManager } from "../../lib/package-manager.js";

import clerkSkillMd from "../../../../../skills/clerk/SKILL.md" with { type: "text" };
import clerkAuthMd from "../../../../../skills/clerk/references/auth.md" with { type: "text" };
import clerkRecipesMd from "../../../../../skills/clerk/references/recipes.md" with { type: "text" };
import clerkAgentModeMd from "../../../../../skills/clerk/references/agent-mode.md" with { type: "text" };

/**
 * Env var that overrides the bundled `clerk` skill source. Accepts any
 * value the `skills` CLI recognises (github/gitlab URL, `org/repo` shorthand,
 * absolute or relative local path). Intended for skill authors testing an
 * in-progress version without recompiling the CLI.
 */
const SKILL_SOURCE_OVERRIDE_ENV = "CLERK_SKILL_SOURCE";

/**
 * Read the clerk skill source override from the given env. Returns the
 * trimmed value when set and non-empty, otherwise `undefined`. Exposed for
 * tests so the precedence rule can be asserted without mutating
 * `process.env`.
 */
export function resolveClerkSkillOverride(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[SKILL_SOURCE_OVERRIDE_ENV];
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The bundled clerk skill, as `(relativePath, content)` pairs. Text
 * imports resolve live from `<repo-root>/skills/clerk/` during
 * `bun run dev` and get embedded into the compiled binary by
 * `bun build --compile`, so the content always matches the CLI being run.
 */
const BUNDLED_CLERK_SKILL: ReadonlyArray<readonly [string, string]> = [
  ["clerk/SKILL.md", clerkSkillMd],
  ["clerk/references/auth.md", clerkAuthMd],
  ["clerk/references/recipes.md", clerkRecipesMd],
  ["clerk/references/agent-mode.md", clerkAgentModeMd],
];

/**
 * Substitute `{{CLI_VERSION}}` in a skill asset with the provided version.
 * When the version is absent (undefined) or is the dev-build sentinel, the
 * placeholder resolves to `latest` so the runnable commands in the skill
 * remain copy-pasteable on unversioned binaries.
 *
 * Exported for tests.
 */
export function renderSkillVersionPlaceholder(
  content: string,
  version: string | undefined,
): string {
  const resolved = version && version !== DEV_CLI_VERSION ? version : "latest";
  return content.replaceAll("{{CLI_VERSION}}", resolved);
}

/**
 * Write the bundled clerk skill to a fresh temp dir and call `fn` with
 * its path. Every asset has `{{CLI_VERSION}}` rendered against `version` first
 * (see {@link renderSkillVersionPlaceholder}). The dir is deleted on return,
 * so `fn` must finish any work that reads from it before returning.
 *
 * Exported for tests.
 */
export async function withStagedClerkSkill<T>(
  version: string | undefined,
  fn: (stageDir: string) => Promise<T>,
): Promise<T> {
  const stageDir = await mkdtemp(join(tmpdir(), "clerk-skill-"));
  try {
    for (const [rel, content] of BUNDLED_CLERK_SKILL) {
      const dest = join(stageDir, rel);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, renderSkillVersionPlaceholder(content, version));
    }
    return await fn(stageDir);
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

/**
 * Build the runner-agnostic argv for `skills add <source> ...`. The caller
 * prepends the runner (bunx / npx / pnpm dlx / yarn dlx) via
 * {@link runnerCommand}.
 *
 * `skillNames` becomes `--skill <name>` pairs; leave empty to install every
 * skill from `source` (what we do for the bundled clerk source).
 *
 * `copy` forces the `skills` CLI to copy files into each agent dir instead
 * of symlinking. Required for sources that live in an ephemeral directory
 * (our staged clerk skill); optional otherwise.
 *
 * Interactive mode: hand off to the skills CLI's native UX (auto-detect
 * installed agents, scope picker) by omitting `--agent` and `-y`.
 * Non-interactive: pass `-y -g` so it runs unattended with global scope
 * and auto-detected agents.
 *
 * Exported for tests.
 */
export function buildSkillsArgs(
  source: string,
  skillNames: readonly string[],
  interactive: boolean,
  copy: boolean,
): string[] {
  const skillFlags = skillNames.flatMap((s) => ["--skill", s]);
  const extraFlags = interactive ? [] : ["-y", "-g"];
  const copyFlag = copy ? ["--copy"] : [];
  return ["skills", "add", source, ...skillFlags, ...extraFlags, ...copyFlag];
}

/**
 * Run a single `skills add ...` invocation. Returns true on success, false
 * on any failure (spawn error, non-zero exit). Failures print a yellow
 * warning but never throw — skills are optional and shouldn't tear down
 * a successful scaffold.
 */
export async function runSkillsAdd(
  runner: Runner,
  cwd: string,
  source: string,
  skillNames: readonly string[],
  interactive: boolean,
  copy: boolean,
  label: string,
): Promise<boolean> {
  const command = runnerCommand(runner, buildSkillsArgs(source, skillNames, interactive, copy));
  const displayCommand = `${runner.display} skills add ${source}`;

  log.blank();
  log.info(`Installing \`${label}\` with \`${runner.display}\`...`);

  let exitCode: number;
  try {
    const proc = Bun.spawn(command, {
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    exitCode = await proc.exited;
  } catch {
    log.blank();
    log.warn(`Could not run \`${displayCommand}\`. You can install manually later.`);
    return false;
  }

  if (exitCode !== 0) {
    log.blank();
    log.warn(`\`${label}\` installation failed. You can install manually: \`${displayCommand}\``);
    return false;
  }

  return true;
}

/**
 * Resolve a runner for the `skills` CLI. Prompts the user to pick one in
 * interactive mode when multiple are available; otherwise picks the
 * preferred runner for `packageManager`.
 *
 * Returns `null` if no runner is on PATH. In that case a warning is logged
 * so the caller can simply return without further output.
 */
export async function resolveSkillsRunner(
  packageManager: PackageManager | undefined,
  interactive: boolean,
): Promise<Runner | null> {
  const available = detectAvailableRunners();
  if (!isNonEmpty(available)) {
    const suggested = runnerForPackageManager(packageManager);
    log.blank();
    log.warn(
      "No package runner found on PATH (looked for bunx, npx, pnpm, yarn). " +
        `Install one and run \`${suggested.display} skills add <source>\` manually.`,
    );
    return null;
  }

  const preferred = preferredRunner(packageManager, available);

  if (interactive && available.length > 1) {
    return await select<Runner>({
      message: "Which package runner should install the skills?",
      choices: available.map((r) => ({
        name: r.id === preferred.id ? `${r.display} ${dim("(detected)")}` : r.display,
        value: r,
      })),
      default: preferred,
    });
  }

  return preferred;
}

/**
 * Install the clerk skill using a pre-resolved runner. Does not prompt;
 * callers handle any UX around confirmation and runner selection.
 *
 * Default path: stage the bundled content into a temp dir and invoke
 * `skills add <tmpdir> --copy` (the --copy is mandatory; the default symlink
 * mode would point at a dir we're about to delete).
 *
 * Override path: when `CLERK_SKILL_SOURCE` is set, hand the value straight
 * to `skills add` unchanged. No staging, no --copy — the caller owns the
 * source and the install mode. Used by skill authors iterating on clerk
 * without rebuilding the CLI.
 *
 * Shared with the init flow so runner detection happens once when installing
 * clerk alongside the upstream framework-pattern skills.
 */
export async function installClerkSkillCore(
  runner: Runner,
  cwd: string,
  interactive: boolean,
): Promise<boolean> {
  const override = resolveClerkSkillOverride();
  if (override) {
    log.blank();
    log.info(
      `Using \`${SKILL_SOURCE_OVERRIDE_ENV}=${override}\` in place of the bundled clerk skill.`,
    );
    return runSkillsAdd(
      runner,
      cwd,
      override,
      [],
      interactive,
      false,
      `clerk skill (${override})`,
    );
  }
  return withStagedClerkSkill(resolveCliVersion(), (stageDir) =>
    runSkillsAdd(runner, cwd, stageDir, [], interactive, true, "clerk skill"),
  );
}

export interface SkillInstallOptions {
  yes?: boolean;
  pm?: PackageManager;
}

/**
 * `clerk skill install` — standalone install of the bundled clerk skill.
 */
export async function skillInstall(options: SkillInstallOptions): Promise<void> {
  const cwd = process.cwd();
  const skipPrompt = options.yes ?? false;
  const interactive = isHuman() && !skipPrompt;

  const packageManager = options.pm ?? (await detectPackageManager(cwd));

  const runner = await resolveSkillsRunner(packageManager, interactive);
  if (!runner) return;

  const ok = await installClerkSkillCore(runner, cwd, interactive);
  if (ok) {
    log.blank();
    log.success("clerk skill installed. AI agents now have Clerk context in this project.");
  }
}
