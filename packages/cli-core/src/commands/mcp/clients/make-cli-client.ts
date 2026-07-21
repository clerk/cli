/**
 * Factory for clients whose own CLI performs the registration.
 *
 * Claude Code, Gemini, Codex, VS Code, OpenClaw, and Hermes ship a CLI that
 * adds MCP servers to their config. Delegating the *write* to that CLI keeps each client the owner
 * of its config format (and of concurrent-write safety); our file-backed base
 * client stays in charge of *reads* — `configPath` and `list` (which `mcp list`,
 * `doctor`, and the uninstall picker all use).
 *
 * Semantics:
 * - `detect` = "is the client's binary on PATH" (`Bun.which`), not "does the
 *   config dir exist" — the picker only offers clients we can actually drive.
 * - No fallback: a missing binary or failing CLI is that client's failure,
 *   surfaced with the CLI's own stderr. We never write these configs ourselves.
 * - Install always converges: an existing entry is removed (via the client's
 *   own remove command, best-effort) before adding, so re-install works no
 *   matter how the CLI treats duplicate names.
 */

import { CliError, ERROR_CODE, errorMessage } from "../../../lib/errors.ts";
import { log } from "../../../lib/log.ts";
import { findClientBinary, runClientCli } from "./cli-exec.ts";
import { MCP_DOCS_URL } from "./types.ts";
import type { McpClient, McpServerEntry, RemoveResult, UpsertResult } from "./types.ts";

interface CliClientSpec {
  /** File-backed client used for `configPath`/`list` (and `remove` when the CLI has no remove command). */
  base: McpClient;
  /** Binary name resolved on PATH (`claude`, `gemini`, `codex`, `code`, `openclaw`, `hermes`). */
  binary: string;
  /** Appended to the not-found error: how to get the binary onto PATH. */
  installHint: string;
  /** CLI argv (after the binary) that registers the entry. */
  addArgs: (name: string) => string[];
  /** CLI argv (after the binary) that removes the entry. Omit when the CLI can only add (VS Code). */
  removeArgs?: (name: string) => string[];
  /**
   * Text piped to the add command's stdin (e.g. `"y\n"` when add ends in a
   * confirm prompt, as Hermes' does). Default: stdin closed immediately.
   */
  addStdin?: string;
  /**
   * Re-read the config after add and fail if the entry didn't land. For CLIs
   * whose add can exit 0 without saving (Hermes cancels its prompt on
   * unexpected input — with exit 0), where the exit code alone can't be
   * trusted. Skipped when the config is unreadable (the CLI keeps final say).
   */
  verifyAdd?: boolean;
}

export function makeCliClient(spec: CliClientSpec): McpClient {
  const { base, binary } = spec;

  // No display-name prefix in thrown messages: settleClients prefixes the
  // client name when warning, so embedding it here would print it twice.
  function requireBinary(): string {
    const bin = findClientBinary(binary);
    if (bin) return bin;
    throw new CliError(
      `\`${binary}\` CLI not found on PATH — registration is delegated to it. ${spec.installHint}`,
      { code: ERROR_CODE.MCP_CLIENT_CLI_NOT_FOUND, docsUrl: MCP_DOCS_URL },
    );
  }

  /**
   * Presence via our own read-only parse of the client's config — reads stay
   * ours; only writes are delegated. "unknown" = config unreadable, in which
   * case the CLI (which owns the format) gets the final say.
   */
  async function presenceOf(name: string, cwd: string): Promise<"present" | "absent" | "unknown"> {
    try {
      const entries = await base.list(cwd);
      return entries.some((entry) => entry.name === name) ? "present" : "absent";
    } catch {
      return "unknown";
    }
  }

  async function runOrThrow(
    argv: [string, ...string[]],
    action: string,
    stdin?: string,
  ): Promise<void> {
    const result =
      stdin === undefined ? await runClientCli(argv) : await runClientCli(argv, { stdin });
    if (result.exitCode === 0) return;
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new CliError(`failed to ${action} — ${detail}`, {
      code: ERROR_CODE.MCP_CLIENT_CLI_FAILED,
      docsUrl: MCP_DOCS_URL,
    });
  }

  return {
    id: base.id,
    displayName: base.displayName,
    scope: base.scope,
    activation: base.activation,
    configPath: (cwd) => base.configPath(cwd),
    detect: () => Promise.resolve(findClientBinary(binary) !== null),
    list: (cwd) => base.list(cwd),

    async upsert(entry: McpServerEntry, cwd: string): Promise<UpsertResult> {
      const bin = requireBinary();
      const presence = await presenceOf(entry.name, cwd);
      if (presence !== "absent" && spec.removeArgs) {
        // Best-effort pre-clean: duplicate-name behavior varies per CLI, so a
        // failed remove (e.g. "no such server") just means add decides. A
        // non-zero exit is already debug-logged by runClientCli; only a
        // timeout rejects, which we log here before discarding.
        await runClientCli([bin, ...spec.removeArgs(entry.name)]).catch((error: unknown) => {
          log.debug(`mcp: ${base.id} pre-clean remove failed — ${errorMessage(error)}`);
        });
      } else if (presence === "present") {
        await base.remove(entry.name, cwd);
      }
      await runOrThrow(
        [bin, ...spec.addArgs(entry.name)],
        "register the MCP server",
        spec.addStdin,
      );
      if (spec.verifyAdd && (await presenceOf(entry.name, cwd)) === "absent") {
        throw new CliError(
          `the \`${binary}\` CLI reported success but did not save the entry — it may have prompted for input it didn't get. Register manually instead.`,
          { code: ERROR_CODE.MCP_CLIENT_CLI_FAILED, docsUrl: MCP_DOCS_URL },
        );
      }
      return { client: base.id, configPath: base.configPath(cwd), status: "installed" };
    },

    async remove(name: string, cwd: string): Promise<RemoveResult> {
      if (!spec.removeArgs) return base.remove(name, cwd);
      const configPath = base.configPath(cwd);
      if ((await presenceOf(name, cwd)) === "absent") {
        return { client: base.id, configPath, removed: false };
      }
      const bin = requireBinary();
      await runOrThrow([bin, ...spec.removeArgs(name)], "remove the MCP entry");
      return { client: base.id, configPath, removed: true };
    },
  };
}
