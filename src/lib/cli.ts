/**
 * Shared helpers for unified human/agent command output.
 *
 * Uses `using` (explicit resource management) so that agent output
 * is automatically flushed when the command scope exits.
 */

import { isJsonOutput } from "../mode.js";
import { green, yellow } from "./color.js";

export interface CommandOutput extends Disposable {
  /** Record a check result. Printed immediately in human mode. */
  add(name: string, ok: boolean, detail: string, fix?: string): void;
  /** Suggest a next-step command (only shown to agents). */
  suggest(command: string): void;
  /** Attach arbitrary metadata to the JSON output (agent/json mode only). */
  meta(key: string, value: unknown): void;
}

/**
 * Creates a check/fix tracker that auto-renders output on dispose.
 *
 * - Human mode: each `add()` call prints a ✓/✗ line immediately.
 * - JSON output mode: all checks are batched and emitted as JSON when the
 *   resource is disposed (via `using`). Triggered by agent mode or --json flag.
 *
 * @example
 * ```ts
 * async function myCommand() {
 *   using out = createCommandOutput("my-command");
 *   out.add("auth", true, "Logged in");
 *   out.add("linked", false, "Not linked", "clerk link");
 * }
 * ```
 */
export function createCommandOutput(command: string): CommandOutput {
  const checks: {
    name: string;
    ok: boolean;
    detail: string;
    fix?: string;
  }[] = [];
  const suggestions: string[] = [];
  const metadata: Record<string, unknown> = {};

  return {
    add(name: string, ok: boolean, detail: string, fix?: string) {
      checks.push({ name, ok, detail, fix });
      if (!isJsonOutput()) {
        const icon = ok ? green("✓") : yellow("✗");
        const fixHint = !ok && fix ? ` (run: ${fix})` : "";
        console.log(`  ${icon} ${name}: ${detail}${fixHint}`);
      }
    },

    suggest(command: string) {
      suggestions.push(command);
    },

    meta(key: string, value: unknown) {
      metadata[key] = value;
    },

    [Symbol.dispose]() {
      if (!isJsonOutput()) return;

      // Collect fixes from failed checks + explicit suggestions
      const fixes = checks.filter((c) => !c.ok && c.fix).map((c) => c.fix!);
      const next = [...fixes, ...suggestions];

      const data: Record<string, unknown> = {
        command,
        checks: checks.map((c) => ({
          name: c.name,
          ok: c.ok,
          detail: c.detail,
          ...(c.fix ? { fix: c.fix } : {}),
        })),
      };
      if (next.length > 0) data.next = next;
      if (Object.keys(metadata).length > 0) data.meta = metadata;

      console.log(JSON.stringify(data, null, 2));
    },
  };
}
