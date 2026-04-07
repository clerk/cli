/**
 * Install Clerk agent skills after scaffolding.
 *
 * Two installer calls share one runner detection:
 *
 *  1. The `clerk-cli` skill is bundled into the CLI binary via text imports.
 *     At install time we stage the bundled content to a temp directory and
 *     invoke `skills add <tmpdir> --copy`, so the installed files are full
 *     copies (not symlinks into the temp dir, which would break when the
 *     temp dir is cleaned up).
 *
 *  2. The framework-pattern skills (`clerk`, `clerk-setup`,
 *     `clerk-<framework>-patterns`) ship from the upstream `clerk/skills`
 *     repo and version independently of the CLI.
 *
 * The skills CLI itself handles agent auto-detection and scope selection:
 * in interactive mode we hand off entirely (no `--agent` / `-y`), so the
 * user gets the native picker. In non-interactive mode we pass `-y -g`
 * so it runs unattended with global scope and auto-detected agents.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { dim } from "../../lib/color.js";
import { isHuman } from "../../mode.js";
import { log } from "../../lib/log.js";
import { confirm, select } from "../../lib/prompts.js";
import {
  type Runner,
  detectAvailableRunners,
  preferredRunner,
  runnerCommand,
  runnerForPackageManager,
} from "../../lib/runners.js";
import { isNonEmpty } from "../../lib/helpers/arrays.js";
import type { ProjectContext } from "./frameworks/types.js";

import clerkCliSkillMd from "../../../../../skills/clerk-cli/SKILL.md" with { type: "text" };
import clerkCliAuthMd from "../../../../../skills/clerk-cli/references/auth.md" with { type: "text" };
import clerkCliRecipesMd from "../../../../../skills/clerk-cli/references/recipes.md" with { type: "text" };
import clerkCliAgentModeMd from "../../../../../skills/clerk-cli/references/agent-mode.md" with { type: "text" };

/** Upstream skills installed regardless of framework. */
const BASE_SKILLS = ["clerk", "clerk-setup"];

/** Maps framework dep (from package.json) to the upstream skill name. */
const FRAMEWORK_SKILL_MAP: Record<string, string> = {
  next: "clerk-nextjs-patterns",
  react: "clerk-react-patterns",
  "react-router": "clerk-react-router-patterns",
  vue: "clerk-vue-patterns",
  nuxt: "clerk-nuxt-patterns",
  astro: "clerk-astro-patterns",
  "@tanstack/react-start": "clerk-tanstack-patterns",
  expo: "clerk-expo-patterns",
  express: "clerk-backend-api",
  fastify: "clerk-backend-api",
};

/** Source for upstream framework-pattern skills. */
const UPSTREAM_SKILLS_SOURCE = "clerk/skills";

/**
 * The bundled clerk-cli skill, as `(relativePath, content)` pairs. Text
 * imports resolve live from `<repo-root>/skills/clerk-cli/` during
 * `bun run dev` and get embedded into the compiled binary by
 * `bun build --compile`, so the content always matches the CLI being run.
 */
const BUNDLED_CLERK_CLI_SKILL: ReadonlyArray<readonly [string, string]> = [
  ["clerk-cli/SKILL.md", clerkCliSkillMd],
  ["clerk-cli/references/auth.md", clerkCliAuthMd],
  ["clerk-cli/references/recipes.md", clerkCliRecipesMd],
  ["clerk-cli/references/agent-mode.md", clerkCliAgentModeMd],
];

function resolveUpstreamSkills(frameworkDep: string | undefined): string[] {
  const skills = [...BASE_SKILLS];
  if (frameworkDep && FRAMEWORK_SKILL_MAP[frameworkDep]) {
    skills.push(FRAMEWORK_SKILL_MAP[frameworkDep]);
  }
  return skills;
}

/**
 * Write the bundled clerk-cli skill to a fresh temp dir and call `fn` with
 * its path. The dir is deleted on return, so `fn` must finish any work that
 * reads from it before returning.
 *
 * Exported for tests.
 */
export async function withStagedClerkCliSkill<T>(fn: (stageDir: string) => Promise<T>): Promise<T> {
  const stageDir = await mkdtemp(join(tmpdir(), "clerk-cli-skill-"));
  try {
    for (const [rel, content] of BUNDLED_CLERK_CLI_SKILL) {
      const dest = join(stageDir, rel);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, content);
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
 * skill from `source` (what we do for the bundled clerk-cli source).
 *
 * `copy` forces the `skills` CLI to copy files into each agent dir instead
 * of symlinking. Required for sources that live in an ephemeral directory
 * (our staged clerk-cli skill); optional otherwise.
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
async function runSkillsAdd(
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

export async function installSkills(
  cwd: string,
  frameworkDep: string | undefined,
  packageManager: ProjectContext["packageManager"] | undefined,
  skipPrompt: boolean,
): Promise<void> {
  const upstreamSkills = resolveUpstreamSkills(frameworkDep);
  const skillList = ["clerk-cli", ...upstreamSkills].join(", ");

  if (isHuman() && !skipPrompt) {
    const install = await confirm({
      message: `Install agent skills? (${skillList})`,
      default: true,
    });
    if (!install) return;
  }

  // Detect runners after the user accepts — no point probing PATH if they decline.
  const available = detectAvailableRunners();
  if (!isNonEmpty(available)) {
    const suggested = runnerForPackageManager(packageManager);
    log.blank();
    log.warn(
      "No package runner found on PATH (looked for bunx, npx, pnpm, yarn). " +
        `Install one and run \`${suggested.display} skills add ${UPSTREAM_SKILLS_SOURCE}\` manually.`,
    );
    return;
  }

  const preferred = preferredRunner(packageManager, available);

  // Only prompt when there's an actual choice and the user is interactive.
  let runner = preferred;
  if (isHuman() && !skipPrompt && available.length > 1) {
    runner = await select<Runner>({
      message: "Which package runner should install the skills?",
      choices: available.map((r) => ({
        name: r.id === preferred.id ? `${r.display} ${dim("(detected)")}` : r.display,
        value: r,
      })),
      default: preferred,
    });
  }

  const interactive = isHuman() && !skipPrompt;

  // Install the bundled clerk-cli skill from a staged temp dir (--copy so
  // the installed files don't symlink into a dir we're about to delete),
  // then the upstream framework patterns. Each call soft-fails
  // independently so a problem with one source doesn't block the other.
  const cliSkillOk = await withStagedClerkCliSkill((stageDir) =>
    runSkillsAdd(runner, cwd, stageDir, [], interactive, true, "clerk-cli skill"),
  );

  const upstreamOk = await runSkillsAdd(
    runner,
    cwd,
    UPSTREAM_SKILLS_SOURCE,
    upstreamSkills,
    interactive,
    false,
    upstreamSkills.join(", "),
  );

  if (cliSkillOk && upstreamOk) {
    log.blank();
    log.success("Agent skills installed. AI agents now have Clerk context in this project.");
  }
}
