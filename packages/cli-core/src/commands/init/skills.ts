/**
 * Install Clerk agent skills after scaffolding.
 *
 * Two installer calls share one runner detection:
 *
 *  1. The bundled `clerk-cli` skill (embedded in the binary via text
 *     imports). Delegated to the `clerk skill install` core helpers in
 *     `commands/skill/install.ts`.
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

import { isHuman } from "../../mode.js";
import { log } from "../../lib/log.js";
import { confirm } from "../../lib/prompts.js";
import type { ProjectContext } from "./frameworks/types.js";
import { installClerkCliSkillCore, resolveSkillsRunner, runSkillsAdd } from "../skill/install.js";

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

function resolveUpstreamSkills(frameworkDep: string | undefined): string[] {
  const skills = [...BASE_SKILLS];
  if (frameworkDep && FRAMEWORK_SKILL_MAP[frameworkDep]) {
    skills.push(FRAMEWORK_SKILL_MAP[frameworkDep]);
  }
  return skills;
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

  const interactive = isHuman() && !skipPrompt;

  // Detect runner after the user accepts — no point probing PATH if they decline.
  const runner = await resolveSkillsRunner(packageManager, interactive);
  if (!runner) return;

  // Install the bundled clerk-cli skill from a staged temp dir, then the
  // upstream framework patterns. Each call soft-fails independently so a
  // problem with one source doesn't block the other.
  const cliSkillOk = await installClerkCliSkillCore(runner, cwd, interactive);

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
