/**
 * Install Clerk agent skills after scaffolding.
 *
 * Maps the detected framework to the appropriate skill set from
 * github.com/clerk/skills, then installs via the user's package runner
 * (bunx, npx, pnpm dlx, or yarn dlx).
 *
 * The skills CLI itself handles agent auto-detection and scope selection:
 * in interactive mode we hand off entirely (no `--agent` / `-y`), so the
 * user gets the native picker. In non-interactive mode we pass `-y -g`
 * so it runs unattended with global scope and auto-detected agents.
 */

import type { Need } from "../../lib/deps.ts";
import { dim } from "../../lib/color.ts";
import {
  type Runner,
  detectAvailableRunners,
  preferredRunner,
  runnerCommand,
  runnerForPackageManager,
} from "../../lib/runners.ts";
import type { ProjectContext } from "./frameworks/types.ts";

/**
 * Subprocess spawn function, injected so tests can replace the real
 * `Bun.spawn` with a no-op stub. Without injection, a test that forgets
 * to mock installSkills will write `.adal/`, `.agents/`, `skills/`, and
 * `skills-lock.json` into whichever directory the test's `cwd` points at,
 * polluting the repository.
 */
export type SpawnFn = (
  cmd: string[],
  options: {
    cwd: string;
    stdin?: "inherit" | "ignore" | "pipe";
    stdout: "inherit" | "ignore";
    stderr: "inherit" | "ignore";
  },
) => { exited: Promise<number> };

export type InstallSkillsDeps = Need<{
  mode: "isHuman";
  prompts: "confirm" | "select";
  log: "info" | "warn" | "success" | "blank";
}>;

/** Skills installed regardless of framework. */
const BASE_SKILLS = ["clerk", "clerk-setup"];

/** Maps framework dep (from package.json) to the skill name in clerk/skills. */
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

const SKILLS_SOURCE = "clerk/skills";

function resolveSkills(frameworkDep: string | undefined): string[] {
  const skills = [...BASE_SKILLS];
  if (frameworkDep && FRAMEWORK_SKILL_MAP[frameworkDep]) {
    skills.push(FRAMEWORK_SKILL_MAP[frameworkDep]);
  }
  return skills;
}

/**
 * Build the runner-agnostic argv for `skills add ...`. The caller prepends
 * the runner (bunx / npx / pnpm dlx / yarn dlx) via {@link runnerCommand}.
 *
 * Interactive mode: hand off to the skills CLI's native UX (auto-detect
 * installed agents, scope picker) by omitting `--agent` and `-y`.
 * Non-interactive: pass `-y -g` so it runs unattended with global scope
 * and auto-detected agents.
 *
 * Exported for tests.
 */
export function buildSkillsArgs(skills: string[], interactive: boolean): string[] {
  const skillFlags = skills.flatMap((s) => ["--skill", s]);
  const extraFlags = interactive ? [] : ["-y", "-g"];
  return ["skills", "add", SKILLS_SOURCE, ...skillFlags, ...extraFlags];
}

const defaultSpawn: SpawnFn = (cmd, options) => Bun.spawn(cmd, options);

export async function installSkills(
  deps: InstallSkillsDeps,
  cwd: string,
  frameworkDep: string | undefined,
  packageManager: ProjectContext["packageManager"] | undefined,
  skipPrompt: boolean,
  spawn: SpawnFn = defaultSpawn,
): Promise<void> {
  const skills = resolveSkills(frameworkDep);
  const skillList = skills.join(", ");

  if (deps.mode.isHuman() && !skipPrompt) {
    const install = await deps.prompts.confirm({
      message: `Install agent skills? (${skillList})`,
      default: true,
    });
    if (!install) return;
  }

  // Detect runners after the user accepts, no point probing PATH if they decline.
  const available = detectAvailableRunners();
  if (available.length === 0) {
    const suggested = runnerForPackageManager(packageManager);
    deps.log.blank();
    deps.log.warn(
      "No package runner found on PATH (looked for bunx, npx, pnpm, yarn). " +
        `Install one and run \`${suggested.display} skills add ${SKILLS_SOURCE}\` manually.`,
    );
    return;
  }

  const preferred = preferredRunner(packageManager, available);
  if (!preferred) {
    // Defensive: detectAvailableRunners returned a non-empty array above, so
    // preferredRunner should always find something. This guards against any
    // future change that decouples the two.
    const suggested = runnerForPackageManager(packageManager);
    deps.log.blank();
    deps.log.warn(
      `Could not select a package runner. Run \`${suggested.display} skills add ${SKILLS_SOURCE}\` manually.`,
    );
    return;
  }

  // Only prompt when there's an actual choice and the user is interactive.
  let runner = preferred;
  if (deps.mode.isHuman() && !skipPrompt && available.length > 1) {
    runner = await deps.prompts.select<Runner>({
      message: "Which package runner should install the skills?",
      choices: available.map((r) => ({
        name: r.id === preferred.id ? `${r.display} ${dim("(detected)")}` : r.display,
        value: r,
      })),
      default: preferred,
    });
  }

  const interactive = deps.mode.isHuman() && !skipPrompt;
  const command = runnerCommand(runner, buildSkillsArgs(skills, interactive));
  const displayCommand = `${runner.display} skills add ${SKILLS_SOURCE}`;

  deps.log.blank();
  deps.log.info(`Installing skills with \`${runner.display}\`: \`${skillList}\``);

  // Skills are optional, soft-fail with a warning rather than tearing down
  // a successful scaffold. Bun.spawn can throw synchronously when the binary
  // is missing (e.g. a runner not on PATH on a minimal CI image), so the
  // try/catch is needed in addition to the exit code check below.
  let exitCode: number;
  try {
    const proc = spawn(command, {
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    exitCode = await proc.exited;
  } catch {
    deps.log.blank();
    deps.log.warn(`Could not run \`${displayCommand}\`. You can install manually later.`);
    return;
  }

  if (exitCode !== 0) {
    deps.log.blank();
    deps.log.warn(`Skills installation failed. You can install manually: \`${displayCommand}\``);
    return;
  }

  deps.log.blank();
  deps.log.success("Agent skills installed. AI agents now have Clerk context in this project.");
}
