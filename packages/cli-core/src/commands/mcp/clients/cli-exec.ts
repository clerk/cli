/**
 * Subprocess runner for MCP client CLIs (`claude`, `gemini`, `codex`, `code`,
 * `openclaw`, `hermes`).
 *
 * Registration is delegated to each client's own CLI, which is trusted to
 * manage its config format. Two guardrails keep that delegation from breaking
 * the agent-mode "never blocks" guarantee: by default stdin is closed so a CLI
 * that tries to prompt sees EOF and errors instead of waiting (a client can
 * opt into piped stdin instead, as Hermes does via `addStdin`), and a hard
 * timeout kills a CLI that hangs anyway (e.g. polling for a TTY).
 */

import { CliError, ERROR_CODE } from "../../../lib/errors.ts";
import { log } from "../../../lib/log.ts";
import { MCP_DOCS_URL } from "./types.ts";

/** Resolve a client CLI binary on PATH. Null when the CLI isn't installed. */
export function findClientBinary(binary: string): string | null {
  return Bun.which(binary);
}

interface ClientCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const CLIENT_CLI_TIMEOUT_MS = 15_000;

/**
 * Adapt an argv for the host platform. On Windows, npm-installed client CLIs
 * (`claude`, `gemini`, …) resolve to `.cmd`/`.bat` shims — cmd.exe scripts that
 * can't be spawned directly and must run through `cmd.exe /c`.
 */
export function toSpawnArgv(
  argv: [string, ...string[]],
  platform: NodeJS.Platform = process.platform,
): [string, ...string[]] {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(argv[0])) {
    return ["cmd.exe", "/c", ...argv];
  }
  return argv;
}

/**
 * Run a client CLI to completion and capture its output. Non-zero exits are
 * returned, not thrown — interpreting failure (and naming the client in the
 * message) is the caller's job. Only a timeout rejects, because there is no
 * exit result to return once the process is killed.
 *
 * `stdin` pipes the given text to the child then closes (for CLIs whose
 * command ends in a y/N prompt, e.g. Hermes' `mcp add`); by default stdin is
 * closed immediately so a prompting CLI sees EOF instead of blocking.
 */
export async function runClientCli(
  argv: [string, ...string[]],
  options: { timeoutMs?: number; stdin?: string } = {},
): Promise<ClientCliResult> {
  const timeoutMs = options.timeoutMs ?? CLIENT_CLI_TIMEOUT_MS;
  const proc = Bun.spawn(toSpawnArgv(argv), {
    stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (timedOut) {
      throw new CliError(
        `\`${argv.join(" ")}\` timed out after ${Math.round(timeoutMs / 1000)}s — the client CLI may be waiting for input.`,
        { code: ERROR_CODE.MCP_CLIENT_CLI_FAILED, docsUrl: MCP_DOCS_URL },
      );
    }
    // On failure, include the CLI's output so `--verbose` leaves a full trail
    // even when the caller swallows the result (e.g. the best-effort pre-clean).
    const detail = exitCode === 0 ? "" : ` — ${(stderr.trim() || stdout.trim()).slice(0, 500)}`;
    log.debug(`mcp: exec \`${argv.join(" ")}\` → exit ${exitCode}${detail}`);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
