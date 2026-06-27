#!/usr/bin/env bun
import { createProgram, runProgram } from "./cli-program.ts";
import { cliSigintHandler } from "./lib/signals.ts";
process.on("SIGINT", cliSigintHandler);

// Fast path for shell completion — intercept before Commander parses
// to avoid validation errors on partial input from Tab presses.
const args = process.argv.slice(2);
if (args[0] === "__complete") {
  const { completeHandler } = await import("./commands/completion/__complete.ts");
  completeHandler(createProgram(), args.slice(1));
  process.exit(0);
}

runProgram(createProgram());
