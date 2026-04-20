/**
 * Install Clerk agent skills after scaffolding.
 *
 * Two installer calls share one runner detection:
 *
 *  1. The bundled `clerk` skill (embedded in the binary via text
 *     imports). Delegated to the `clerk skill install` core helpers in
 *     `commands/skill/install.ts`.
 *
 *  2. The upstream skills (`clerk-setup`, `clerk-custom-ui`,
 *     `clerk-backend-api`, `clerk-orgs`, `clerk-testing`, `clerk-webhooks`,
 *     plus a framework-specific skill when one matches) ship from the
 *     upstream `clerk/skills` repo and version independently of the CLI.
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
import { installClerkSkillCore, resolveSkillsRunner, runSkillsAdd } from "../skill/install.js";

/** Upstream skills from clerk/skills — installed on every project (excludes the bundled clerk skill). */
const DEFAULT_UPSTREAM_SKILLS = [
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
const FRAMEWORK_SKILL_MAP: Record<string, string> = {
  next: "clerk-nextjs-patterns",
  react: "clerk-react-patterns",
  "react-router": "clerk-react-router-patterns",
  vue: "clerk-vue-patterns",
  nuxt: "clerk-nuxt-patterns",
  astro: "clerk-astro-patterns",
  "@tanstack/react-start": "clerk-tanstack-patterns",
  expo: "clerk-expo-patterns",
};

// Guard against accidental overlap: Set.add() silently deduplicates, masking dead entries.
for (const [dep, skill] of Object.entries(FRAMEWORK_SKILL_MAP)) {
  if (DEFAULT_UPSTREAM_SKILLS.includes(skill)) {
    throw new Error(
      `FRAMEWORK_SKILL_MAP['${dep}'] maps to '${skill}', which is already in DEFAULT_UPSTREAM_SKILLS. Remove it from the map.`,
    );
  }
}

/** Source for upstream framework-pattern skills. */
const UPSTREAM_SKILLS_SOURCE = "clerk/skills";

export function resolveUpstreamSkills(frameworkDep: string | undefined): string[] {
  const skills = new Set(DEFAULT_UPSTREAM_SKILLS);
  if (frameworkDep && FRAMEWORK_SKILL_MAP[frameworkDep]) {
    skills.add(FRAMEWORK_SKILL_MAP[frameworkDep]);
  }
  return [...skills];
}

export function getFrameworkSkill(frameworkDep: string | undefined): string | undefined {
  return frameworkDep ? FRAMEWORK_SKILL_MAP[frameworkDep] : undefined;
}

function formatSkillsSummary(frameworkSkill: string | undefined): string {
  const framework = frameworkSkill ? ` + ${frameworkSkill.replace(/^clerk-/, "")}` : "";
  return `clerk core + features${framework}`;
}

export function formatSkillsPromptMessage(frameworkSkill: string | undefined): string {
  return `Install agent skills? (${formatSkillsSummary(frameworkSkill)})`;
}

export async function installSkills(
  cwd: string,
  frameworkDep: string | undefined,
  packageManager: ProjectContext["packageManager"] | undefined,
  skipPrompt: boolean,
): Promise<void> {
  const upstreamSkills = resolveUpstreamSkills(frameworkDep);
  const frameworkSkill = getFrameworkSkill(frameworkDep);

  if (isHuman() && !skipPrompt) {
    const install = await confirm({
      message: formatSkillsPromptMessage(frameworkSkill),
      default: true,
    });
    if (!install) return;
  }

  const interactive = isHuman() && !skipPrompt;

  // Detect runner after the user accepts — no point probing PATH if they decline.
  const runner = await resolveSkillsRunner(packageManager, interactive);
  if (!runner) return;

  // Install the bundled clerk skill from a staged temp dir, then the
  // upstream framework patterns. Each call soft-fails independently so a
  // problem with one source doesn't block the other.
  const cliSkillOk = await installClerkSkillCore(runner, cwd, interactive);

  log.debug(`skills: upstream install — ${upstreamSkills.join(", ")}`);
  const upstreamOk = await runSkillsAdd(
    runner,
    cwd,
    UPSTREAM_SKILLS_SOURCE,
    upstreamSkills,
    interactive,
    false,
    formatSkillsSummary(frameworkSkill),
  );

  if (cliSkillOk && upstreamOk) {
    log.blank();
    log.success("Agent skills installed. AI agents now have Clerk context in this project.");
  }
}
