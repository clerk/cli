import type { Program } from "../../cli-program.ts";
import { isExperimentEnabled, requireExperiment } from "../../lib/experimental.ts";

export function registerMigrate(program: Program, env: NodeJS.ProcessEnv = process.env): void {
  if (!isExperimentEnabled("migrate", env)) {
    // A hidden stub rather than no command at all: `clerk migrate` then says how
    // to turn it on instead of "unknown command". It has no subcommands, so
    // completion has nothing to walk, and it accepts anything, so every
    // invocation reaches the refusal.
    const stub = program
      .command("migrate", { hidden: true })
      .helpOption(false)
      .allowUnknownOption()
      .allowExcessArguments()
      .argument("[args...]")
      .action(() => requireExperiment("migrate", env));
    // `clerk help migrate` renders help without running the action.
    stub.helpInformation = () => {
      requireExperiment("migrate", env);
      return "";
    };
    return;
  }

  program
    .command("migrate")
    .description("Migrate users into Clerk from another auth provider or another Clerk instance");
}
