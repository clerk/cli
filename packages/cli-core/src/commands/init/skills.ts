/**
 * Install Clerk agent skills after scaffolding.
 *
 * Maps the detected framework to the appropriate skill set from
 * github.com/clerk/skills, then installs via `npx skills add`.
 */

import type { Need } from "../../lib/deps.ts";
import { dim, cyan, yellow } from "../../lib/color.ts";

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
  prompts: "confirm";
  log: "info" | "warn";
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
 * Build the argv for `npx skills add`.
 *
 * Interactive mode: hand off to the skills CLI's native UX (auto-detect
 * installed agents, scope picker). Non-interactive: pass `-y -g` so it
 * runs unattended with global scope and auto-detected agents.
 *
 * Exported for tests.
 */
export function buildSkillsArgs(skills: string[], interactive: boolean): string[] {
  const skillFlags = skills.flatMap((s) => ["--skill", s]);
  const extraFlags = interactive ? [] : ["-y", "-g"];
  return ["npx", "skills", "add", SKILLS_SOURCE, ...skillFlags, ...extraFlags];
}

const defaultSpawn: SpawnFn = (cmd, options) => Bun.spawn(cmd, options);

export async function installSkills(
  deps: InstallSkillsDeps,
  cwd: string,
  frameworkDep: string | undefined,
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

  deps.log.info(`\nInstalling skills: ${cyan(skillList)}`);

  const interactive = deps.mode.isHuman() && !skipPrompt;
  const args = buildSkillsArgs(skills, interactive);

  // Skills are optional, soft-fail with a warning rather than tearing down
  // a successful scaffold. Bun.spawn can throw synchronously when the binary
  // is missing (e.g. `npx` not on PATH on a minimal CI image), so the
  // try/catch is needed in addition to the exit code check below.
  let exitCode: number;
  try {
    const proc = spawn(args, {
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    exitCode = await proc.exited;
  } catch {
    deps.log.warn(
      yellow(
        `\nCould not run \`npx skills add\`. You can install manually later: npx skills add ${SKILLS_SOURCE}`,
      ),
    );
    return;
  }

  if (exitCode !== 0) {
    deps.log.warn(
      yellow(
        `\nSkills installation failed. You can install manually: npx skills add ${SKILLS_SOURCE}`,
      ),
    );
    return;
  }

  deps.log.info(dim("\nAgent skills installed. AI agents now have Clerk context in this project."));
}
