import { createArgument } from "@commander-js/extra-typings";
import type { Program } from "../../cli-program.ts";
import { parseIntegerOption } from "../../lib/option-parsers.ts";
import { impersonate } from "./impersonate.ts";
import { revoke } from "./revoke.ts";

export function registerImpersonate(program: Program): void {
  const impersonateCommand = program
    .command("impersonate")
    .alias("imp")
    .description("Impersonate a Clerk user")
    .addArgument(
      createArgument(
        "[user]",
        "User ID (user_...), exact email, or search term to impersonate. Omit to pick interactively.",
      ),
    )
    .option("--secret-key <key>", "Backend API secret key to use")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--actor <context>", "Extra context appended to the actor stamp: cli:<email>+<context>")
    .option("--expires-in <seconds>", "Actor token lifetime in seconds (default 3600)", (value) =>
      parseIntegerOption(value, "--expires-in", { min: 1 }),
    )
    .option("--open", "Open the sign-in URL in your browser immediately, skipping the prompt")
    .option("--print", "Print the sign-in URL only — no prompt, no browser")
    .option("--yes", "Skip the impersonation confirmation prompt")
    .setExamples([
      { command: "clerk imp", description: "Pick a user interactively and impersonate" },
      { command: "clerk imp user_2x9k", description: "Impersonate a specific user" },
      {
        command: "clerk imp alice@example.com --open",
        description: "Impersonate by exact email and open the session in your browser",
      },
      { command: "clerk imp revoke act_29w9...", description: "Revoke a pending actor token" },
    ])
    .action((user, _opts, cmd) =>
      impersonate({
        ...(cmd.optsWithGlobals() as Parameters<typeof impersonate>[0]),
        user,
      }),
    );

  impersonateCommand
    .command("revoke")
    .description("Revoke an actor token, or its impersonation session if already accepted")
    .addArgument(createArgument("<actorTokenId>", "Actor token ID to revoke"))
    .option(
      "--user <id>",
      "Impersonated user's ID (user_...) — required to end the session once the token was accepted",
    )
    .option("--secret-key <key>", "Backend API secret key to use")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .setExamples([
      { command: "clerk imp revoke act_29w9...", description: "Revoke a pending actor token" },
      {
        command: "clerk imp revoke act_29w9... --user user_2x9k",
        description: "Also end the live impersonation session if the token was already accepted",
      },
    ])
    .action((actorTokenId, _opts, cmd) =>
      revoke({
        ...(cmd.optsWithGlobals() as Parameters<typeof revoke>[0]),
        actorTokenId,
      }),
    );
}
