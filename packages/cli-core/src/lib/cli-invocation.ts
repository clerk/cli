import { realpathSync } from "node:fs";
import { basename, delimiter, resolve } from "node:path";
import { log } from "./log.ts";

/** How this process was started, as far as choosing a command's first words needs. */
export interface LaunchFacts {
  /** `process.execPath`: the compiled CLI, or `bun` for a source run. */
  execPath: string;
  /** `process.argv[1]`: the script a source run executes. */
  script: string | undefined;
  platform: NodeJS.Platform;
  /** Where `clerk` resolves on PATH, or null when it doesn't. */
  clerkOnPath: string | null;
  /** A path with its symlinks resolved, or the path itself when that fails. */
  realpath: (path: string) => string;
}

/** Single-quotes a word for bash and zsh, so nothing in it is expanded or split. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * The first words of a command an agent runs as given: `clerk` only when the
 * `clerk` on PATH is this same install, else the running CLI by its quoted
 * path, so the command neither fails on a missing `clerk` nor runs another one.
 */
export function cliPrefixFor(facts: LaunchFacts): string {
  // No single quoting works in both PowerShell and cmd.exe, and the commands
  // copied as given are written for bash and zsh.
  if (facts.platform === "win32") return "clerk";
  const sourceRun = /^bun(\.exe)?$/i.test(basename(facts.execPath)) && facts.script !== undefined;
  const running = sourceRun ? resolve(facts.script!) : facts.execPath;
  if (facts.clerkOnPath && facts.realpath(facts.clerkOnPath) === facts.realpath(running)) {
    return "clerk";
  }
  return sourceRun
    ? `${shellQuote(facts.execPath)} ${shellQuote(running)}`
    : shellQuote(facts.execPath);
}

/** {@link cliPrefixFor} with `clerk` looked up on `PATH` and paths resolved on disk. */
export function lookupCliPrefix(launch: {
  PATH: string;
  execPath: string;
  script: string | undefined;
}): string {
  // `bun run`, `npm run` and runners put `node_modules/.bin` on this process's
  // PATH only, so a `clerk` found there isn't one the agent's shell can run.
  const PATH = launch.PATH.split(delimiter)
    .filter((entry) => !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(entry))
    .join(delimiter);
  const clerkOnPath = Bun.which("clerk", { PATH });
  const prefix = cliPrefixFor({
    execPath: launch.execPath,
    script: launch.script,
    platform: process.platform,
    clerkOnPath,
    realpath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    },
  });
  log.debug(`cli: command prefix ${prefix} (clerk on PATH: ${clerkOnPath ?? "none"})`);
  return prefix;
}

let pinned: string | undefined;
let resolved: string | undefined;

/** {@link lookupCliPrefix} for this process, worked out once. */
export function currentCliPrefix(): string {
  if (pinned !== undefined) return pinned;
  resolved ??= lookupCliPrefix({
    PATH: process.env.PATH ?? "",
    execPath: process.execPath,
    script: process.argv[1],
  });
  return resolved;
}

/** Test hook: fixes the prefix {@link currentCliPrefix} returns; `undefined` unfixes it. */
export function _setCliPrefix(prefix: string | undefined): void {
  pinned = prefix;
}
