import type { Program } from "../../cli-program.ts";
import { printBanner } from "../../lib/banner.ts";
import { login } from "./login.ts";
import { logout } from "./logout.ts";

export function registerAuth(program: Program): void {
  const auth = program
    .command("auth")
    .description("Manage authentication")
    .setExamples([
      { command: "clerk auth login", description: "Log in via browser (OAuth)" },
      { command: "clerk auth logout", description: "Remove stored credentials" },
    ]);

  auth
    .command("login")
    .aliases(["signup", "signin", "sign-in"])
    .description("Log in to your Clerk account")
    .option(
      "-y, --yes",
      "Skip confirmations: sign in again when already logged in, and claim the app `clerk init` created here without asking",
    )
    .setExamples([
      { command: "clerk auth login", description: "Log in via browser (OAuth)" },
      {
        command: "clerk auth login -y",
        description: "Re-authenticate via OAuth without confirmation when already signed in",
      },
    ])
    .action(async (opts) => {
      printBanner();
      await login({ yes: opts.yes });
    });

  auth
    .command("logout")
    .aliases(["signout", "sign-out"])
    .description("Log out of your Clerk account")
    .setExamples([{ command: "clerk auth logout", description: "Remove stored credentials" }])
    .action(logout);

  program
    .command("login", { hidden: true })
    .description("Log in to your Clerk account")
    .option(
      "-y, --yes",
      "Skip confirmations: sign in again when already logged in, and claim the app `clerk init` created here without asking",
    )
    .action(async (opts) => {
      printBanner();
      await login({ yes: opts.yes });
    });

  program
    .command("logout", { hidden: true })
    .description("Log out of your Clerk account")
    .action(logout);
}
