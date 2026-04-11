#!/usr/bin/env bun
// packages/cli-core/src/cli.ts
import { createRoot } from "./lib/root.ts";
import { createProgram, runProgram } from "./cli-program.ts";
import { bootstrap } from "./lib/bootstrap.ts";
import { EXIT_CODE } from "./lib/errors.ts";

process.on("SIGINT", () => process.exit(EXIT_CODE.SIGINT));

// Fast path for shell completion: intercept before Commander parses
// to avoid validation errors on partial input from Tab presses.
const args = process.argv.slice(2);
if (args[0] === "__complete") {
  const { completeHandler } = await import("./commands/completion/__complete.ts");
  completeHandler(createProgram(createRoot()), args.slice(1));
  process.exit(0);
}

const root = createRoot();
await runProgram(createProgram(root), undefined, {
  from: "node",
  preParse: () => bootstrap(root, process.argv.slice(2)),
});
