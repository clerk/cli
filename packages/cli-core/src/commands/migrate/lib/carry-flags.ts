import { quoteArg } from "../../../lib/json-body.ts";

/**
 * The flags that chose a migrate command's runs folder and instance, for a
 * command it suggests. Left out, the suggested command looks in the default
 * runs folder or reaches another instance, and refuses: an agent that follows
 * it loops on exit 2. Values are shell-quoted, and the secret key is a
 * placeholder.
 */
export function carryFlags(options: {
  secretKey?: string;
  app?: string;
  instance?: string;
  runsDir?: string;
}): string[] {
  return [
    ...(options.secretKey ? ["--secret-key", "<key>"] : []),
    ...(options.app ? ["--app", quoteArg(options.app)] : []),
    ...(options.instance ? ["--instance", quoteArg(options.instance)] : []),
    ...(options.runsDir ? ["--runs-dir", quoteArg(options.runsDir)] : []),
  ];
}

/**
 * The import flags that choose which users go in. The run records them, so
 * the command that continues it, wherever it is suggested, repeats them:
 * left out, `--require-password` no longer holds back the users it skipped.
 */
export type ImportFlags = {
  allowPartial?: boolean;
  requirePassword?: boolean;
  skipLegalChecks?: boolean;
};

export function importFlags(options: ImportFlags): string[] {
  return [
    ...(options.allowPartial ? ["--allow-partial"] : []),
    ...(options.requirePassword ? ["--require-password"] : []),
    ...(options.skipLegalChecks ? ["--skip-legal-checks"] : []),
  ];
}

/** `clerk migrate runs [id]`, reading the runs folder these flags name. */
export function runsCommand(carry: string[], id?: string): string {
  return withFlags(id ? `clerk migrate runs ${id}` : "clerk migrate runs", carry);
}

/** `clerk migrate undo <id>` with the flags that reach its runs folder and instance. */
export function undoCommand(id: string, carry: string[]): string {
  return withFlags(`clerk migrate undo ${id}`, carry);
}

/** `--` flags appended to a command, or nothing. */
export function withFlags(command: string, flags: string[]): string {
  return flags.length > 0 ? `${command} ${flags.join(" ")}` : command;
}
