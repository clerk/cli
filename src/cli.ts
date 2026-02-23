#!/usr/bin/env node
import { program } from "commander";
import { setMode, type Mode } from "./mode.js";
import { init } from "./commands/init/index.js";
import { login } from "./commands/auth/login.js";
import { logout } from "./commands/auth/logout.js";
import { whoami } from "./commands/whoami/index.js";
import { pull } from "./commands/env/pull.js";
import { deploy } from "./commands/deploy/index.js";
import { configPull } from "./commands/config/pull.js";

program
  .name("clerk")
  .description("Clerk CLI")
  .version(require("../package.json").version)
  .option(
    "--mode <mode>",
    "Force interaction mode (human or agent). Defaults to auto-detect based on TTY.",
  );

program.hook("preAction", () => {
  const opts = program.opts();
  if (opts.mode) {
    if (opts.mode !== "human" && opts.mode !== "agent") {
      console.error(`Invalid mode "${opts.mode}". Must be "human" or "agent".`);
      process.exit(1);
    }
    setMode(opts.mode as Mode);
  }
});

program
  .command("init")
  .description("Initialize Clerk in your project")
  .option("--prompt", "Output a prompt for an AI agent to integrate Clerk")
  .action(init);

const auth = program
  .command("auth")
  .description("Manage authentication");

auth
  .command("login")
  .description("Log in to your Clerk account")
  .action(login);

auth
  .command("logout")
  .description("Log out of your Clerk account")
  .action(logout);

program
  .command("whoami")
  .description("Show the current logged-in user")
  .action(whoami);

const env = program
  .command("env")
  .description("Manage environment variables");

env
  .command("pull")
  .description("Pull environment variables from Clerk to .env.local")
  .action(pull);

const config = program
  .command("config")
  .description("Manage instance configuration");

config
  .command("pull")
  .description("Pull instance configuration from Clerk")
  .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
  .option("--output <file>", "Write config to a file instead of stdout")
  .action(configPull);

program
  .command("deploy", { hidden: true })
  .description("Deploy your Clerk application")
  .option("--debug", "Show debug output")
  .action(deploy);

program.parse();
