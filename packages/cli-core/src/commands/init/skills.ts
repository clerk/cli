/**
 * Install Clerk agent skills after scaffolding.
 *
 * Maps the detected framework to the appropriate skill set from
 * github.com/clerk/skills, then installs via `npx skills add`.
 */

import { dim, cyan, yellow } from "../../lib/color.js";
import { isHuman } from "../../mode.js";
import { confirm } from "../../lib/prompts.js";

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

export async function installSkills(
  cwd: string,
  frameworkDep: string | undefined,
  skipPrompt: boolean,
): Promise<void> {
  const skills = resolveSkills(frameworkDep);
  const skillList = skills.join(", ");

  if (isHuman() && !skipPrompt) {
    const install = await confirm({
      message: `Install agent skills? (${skillList})`,
      default: true,
    });
    if (!install) return;
  }

  console.log(`\nInstalling skills: ${cyan(skillList)}`);

  const skillFlags = skills.flatMap((s) => ["--skill", s]);
  const proc = Bun.spawn(
    ["npx", "skills", "add", SKILLS_SOURCE, ...skillFlags, "--agent", "*", "-y"],
    {
      cwd,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.log(
      yellow(
        `\nSkills installation failed. You can install manually: npx skills add ${SKILLS_SOURCE}`,
      ),
    );
    return;
  }

  console.log(dim("\nAgent skills installed. AI agents now have Clerk context in this project."));
}
