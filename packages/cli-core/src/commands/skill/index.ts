import { createOption, type Command } from "@commander-js/extra-typings";
import { PACKAGE_MANAGERS } from "../../lib/package-manager.ts";
import { skillInstall } from "./install.ts";

export function registerSkill(program: Command): void {
  const skill = program
    .command("skill")
    .description("Manage the bundled Clerk CLI agent skill")
    .setExamples([
      { command: "clerk skill install", description: "Install the clerk agent skill" },
      {
        command: "clerk skill install -y",
        description: "Install non-interactively (auto-detect agents, global scope)",
      },
    ]);

  skill
    .command("install")
    .description("Install the bundled clerk agent skill")
    .option("-y, --yes", "Skip prompts and run the `skills` CLI unattended")
    .addOption(
      createOption("--pm <manager>", "Package manager hint for runner detection").choices(
        PACKAGE_MANAGERS,
      ),
    )
    .setExamples([
      { command: "clerk skill install", description: "Install with an interactive runner picker" },
      { command: "clerk skill install -y", description: "Install unattended" },
      {
        command: "clerk skill install --pm bun",
        description: "Force bunx as the runner",
      },
    ])
    .action(skillInstall);
}
