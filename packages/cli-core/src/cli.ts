#!/usr/bin/env bun
import { createProgram, runProgram } from "./cli-program.ts";
import { CLI_SIGINT_HANDLER } from "./lib/signals.ts";
// Named handler (not an inline arrow) so `webhooks listen` can removeListener it
// to install its own graceful-drain SIGINT handling.
process.on("SIGINT", CLI_SIGINT_HANDLER);

// Fast path for shell completion — intercept before Commander parses
// to avoid validation errors on partial input from Tab presses.
const args = process.argv.slice(2);
if (args[0] === "__complete") {
  const { completeHandler } = await import("./commands/completion/__complete.ts");
  completeHandler(createProgram(), args.slice(1));
  process.exit(0);
}

runProgram(createProgram());
