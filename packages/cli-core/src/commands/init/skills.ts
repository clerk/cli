/**
 * Install Clerk agent skills after scaffolding.
 *
 * The upstream skills (`clerk-cli`, `clerk-setup`, `clerk-custom-ui`,
 * `clerk-backend-api`, `clerk-orgs`, `clerk-testing`, `clerk-webhooks`,
 * plus framework-specific skills when any match) ship from the
 * upstream `clerk/skills` repo and version independently of the CLI.
 *
 * The skills CLI itself handles agent auto-detection and scope selection:
 * in interactive mode we hand off entirely (no `--agent` / `-y`), so the
 * user gets the native picker. In non-interactive mode we pass `-y -g`
 * so it runs unattended with global scope and auto-detected agents.
 */

import { isHuman } from "../../mode.js";
import { log } from "../../lib/log.js";
import { confirm } from "../../lib/prompts.js";
import { resolveSkillsRunner, runSkillsAdd } from "../../lib/skills.js";
import type { ProjectContext } from "./frameworks/types.js";

/** Upstream skills from clerk/skills — installed on every project. */
const DEFAULT_UPSTREAM_SKILLS = [
  // cli/
  "clerk-cli",
  // core/
  "clerk-setup",
  "clerk-custom-ui",
  "clerk-backend-api",
  // features/
  "clerk-orgs",
  "clerk-testing",
  "clerk-webhooks",
];

// Express/Fastify have no entry — their skill is clerk-backend-api, which is a default.
const FRAMEWORK_SKILL_MAP: Record<string, readonly string[]> = {
  next: ["clerk-nextjs-patterns"],
  react: ["clerk-react-patterns"],
  "react-router": ["clerk-react-router-patterns"],
  vue: ["clerk-vue-patterns"],
  nuxt: ["clerk-nuxt-patterns"],
  astro: ["clerk-astro-patterns"],
  "@tanstack/react-start": ["clerk-tanstack-patterns"],
  // Expo gets the mobile setup skill (mobile/clerk-expo) plus the patterns skill.
  expo: ["clerk-expo", "clerk-expo-patterns"],
};

// Guard against accidental overlap: Set.add() silently deduplicates, masking dead entries.
for (const [dep, skills] of Object.entries(FRAMEWORK_SKILL_MAP)) {
  for (const skill of skills) {
    if (DEFAULT_UPSTREAM_SKILLS.includes(skill)) {
      throw new Error(
        `FRAMEWORK_SKILL_MAP['${dep}'] includes '${skill}', which is already in DEFAULT_UPSTREAM_SKILLS. Remove it from the map.`,
      );
    }
  }
}

/** Source for upstream framework-pattern skills. */
const UPSTREAM_SKILLS_SOURCE = "clerk/skills";

export function resolveUpstreamSkills(frameworkDep: string | undefined): string[] {
  const skills = new Set(DEFAULT_UPSTREAM_SKILLS);
  for (const skill of getFrameworkSkills(frameworkDep)) {
    skills.add(skill);
  }
  return [...skills];
}

export function getFrameworkSkills(frameworkDep: string | undefined): readonly string[] {
  return (frameworkDep && FRAMEWORK_SKILL_MAP[frameworkDep]) || [];
}

function formatSkillsSummary(frameworkSkills: readonly string[]): string {
  const framework = frameworkSkills.map((skill) => ` + ${skill.replace(/^clerk-/, "")}`).join("");
  return `clerk-cli + core + features${framework}`;
}

export function formatSkillsPromptMessage(frameworkSkills: readonly string[]): string {
  return `Install agent skills? (${formatSkillsSummary(frameworkSkills)})`;
}

export async function installSkills(
  cwd: string,
  frameworkDep: string | undefined,
  packageManager: ProjectContext["packageManager"] | undefined,
  skipPrompt: boolean,
): Promise<void> {
  const upstreamSkills = resolveUpstreamSkills(frameworkDep);
  const frameworkSkills = getFrameworkSkills(frameworkDep);

  if (isHuman() && !skipPrompt) {
    const install = await confirm({
      message: formatSkillsPromptMessage(frameworkSkills),
      default: true,
    });
    if (!install) return;
  }

  const interactive = isHuman() && !skipPrompt;

  // Detect runner after the user accepts — no point probing PATH if they decline.
  const runner = await resolveSkillsRunner(packageManager, interactive);
  if (!runner) return;

  log.debug(`skills: upstream install — ${upstreamSkills.join(", ")}`);
  const upstreamOk = await runSkillsAdd(
    runner,
    cwd,
    UPSTREAM_SKILLS_SOURCE,
    upstreamSkills,
    interactive,
    formatSkillsSummary(frameworkSkills),
  );

  if (upstreamOk) {
    log.blank();
    log.success("Agent skills installed. AI agents now have Clerk context in this project.");
  }
}
