#!/usr/bin/env node
import { createProgram } from "./cli-program.js";
import { CliError, UserAbortError, ApiError, EXIT_CODE } from "./lib/errors.js";
import { red } from "./lib/color.js";

function formatApiBody(body: string, verbose: boolean): string {
  if (verbose) {
    try {
      return "\n" + JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return "\n" + body;
    }
  }

  try {
    const parsed = JSON.parse(body);
    if (parsed.errors?.[0]?.message) return parsed.errors[0].message;
    if (parsed.error) return parsed.error;
    if (parsed.message) return parsed.message;
  } catch {
    // not JSON
  }

  if (body.length > 200) return body.slice(0, 200) + "...";
  return body;
}

const program = createProgram();

async function main(): Promise<void> {
  try {
    await program.parseAsync();
  } catch (error) {
    const verbose = program.opts().verbose ?? false;

    if (error instanceof UserAbortError) {
      process.exit(EXIT_CODE.SUCCESS);
    }

    if (error instanceof CliError) {
      if (error.message) {
        console.error(red(`error: ${error.message}`));
      }
      if (error.docsUrl) {
        console.error(`\nFor more information, see: ${error.docsUrl}`);
      }
      process.exit(error.exitCode);
    }

    if (error instanceof ApiError) {
      const detail = formatApiBody(error.body, verbose);
      const prefix = error.context ?? "Request failed";
      console.error(red(`error: ${prefix} (${error.status}): ${detail}`));
      process.exit(EXIT_CODE.GENERAL);
    }

    if (error instanceof Error) {
      console.error(red(`error: ${error.message}`));
      process.exit(EXIT_CODE.GENERAL);
    }

    console.error(red("error: An unexpected error occurred"));
    process.exit(EXIT_CODE.GENERAL);
  }
}

main();
