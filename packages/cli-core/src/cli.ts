#!/usr/bin/env node
import { createProgram, runProgram } from "./cli-program.ts";
import { EXIT_CODE } from "./lib/errors.ts";
process.on("SIGINT", () => process.exit(EXIT_CODE.SIGINT));
runProgram(createProgram());
