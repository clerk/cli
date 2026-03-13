#!/usr/bin/env node
import { createProgram, runProgram } from "./cli-program.js";
import { EXIT_CODE } from "./lib/errors.js";
process.on("SIGINT", () => process.exit(EXIT_CODE.SIGINT));
runProgram(await createProgram());
