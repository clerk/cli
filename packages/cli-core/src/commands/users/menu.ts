import { select } from "../../lib/listage.ts";
import { intro, outro } from "../../lib/spinner.ts";
import { isAgent } from "../../mode.ts";
import { log } from "../../lib/log.ts";
import { throwUsageError } from "../../lib/errors.ts";
import { listUsersActions, type UsersActionTargeting } from "./registry.ts";

export async function usersMenu(targeting: UsersActionTargeting = {}): Promise<void> {
  const actions = listUsersActions();

  if (isAgent()) {
    log.info("clerk users requires a subcommand. Available actions:");
    for (const action of actions) {
      log.info(`  ${action.key.padEnd(16)} ${action.description}`);
    }
    throwUsageError("Pass a subcommand. Example: clerk users list");
    return;
  }

  if (actions.length === 0) {
    throwUsageError("No `clerk users` actions are registered.");
    return;
  }

  intro("Managing users");
  const chosenKey = await select<string>({
    message: "What would you like to do?",
    choices: actions.map((action) => ({
      value: action.key,
      name: action.label,
      description: action.description,
    })),
  });

  const chosen = actions.find((action) => action.key === chosenKey);
  if (!chosen) {
    throwUsageError(`Unknown action: ${chosenKey}`);
    return;
  }

  await chosen.handler(targeting);
  outro();
}
