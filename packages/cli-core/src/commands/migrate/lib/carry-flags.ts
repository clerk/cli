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

/** `--` flags appended to a command, or nothing. */
export function withFlags(command: string, flags: string[]): string {
  return flags.length > 0 ? `${command} ${flags.join(" ")}` : command;
}
