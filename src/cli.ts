#!/usr/bin/env node
import { program } from "commander";
import { init } from "./commands/init.js";
import { login } from "./commands/auth/login.js";
import { logout } from "./commands/auth/logout.js";
import { whoami } from "./commands/whoami.js";
import { pull } from "./commands/env/pull.js";

program
  .name("clerk")
  .description("Clerk CLI")
  .version("0.0.1");

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

program.parse();
