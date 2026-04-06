/**
 * Helpers for interacting with the 1Password CLI (`op`).
 *
 * Secrets are resolved in-memory via `op read` and never written to disk.
 */

import { $ } from "bun";

const OP_ACCOUNT = "team-clerk";

const INSTALL_HINT =
  "1Password CLI is not installed. Install it with `brew install 1password-cli`.";
const INTEGRATION_HINT =
  "Have you enabled the 1Password CLI in your 1Password settings? See https://developer.1password.com/docs/cli/get-started/#step-2-turn-on-the-1password-desktop-app-integration for more information.";

/**
 * Throw if the `op` CLI is not available on PATH.
 */
export async function ensureOpInstalled(): Promise<void> {
  const installed = await $`op --version`
    .quiet()
    .then((res) => res.exitCode === 0)
    .catch(() => false);

  if (!installed) {
    throw new Error(INSTALL_HINT);
  }
}

/**
 * Read a secret or document from 1Password by `op://` reference.
 * Throws with a helpful hint if the read fails.
 */
export async function readOpItem(reference: string): Promise<string> {
  const result = await $`op read ${reference}`
    .env({ ...process.env, OP_ACCOUNT })
    .quiet()
    .then((res) => (res.exitCode === 0 ? res.stdout.toString() : null))
    .catch(() => null);

  if (result === null) {
    throw new Error(`Failed to read ${reference} from 1Password. ${INTEGRATION_HINT}`);
  }

  return result;
}

/**
 * Run a command via `op run`, with `op://` references injected as env vars
 * that `op run` resolves in-memory before invoking the subprocess. Stdio is
 * inherited from the parent. Returns the subprocess exit code.
 */
export async function runWithOpSecrets(
  command: string[],
  references: Record<string, string>,
): Promise<number> {
  if (command.length === 0) {
    throw new Error("runWithOpSecrets requires at least one command argument.");
  }

  const proc = Bun.spawn(["op", "run", "--", ...command], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, OP_ACCOUNT, ...references },
  });

  return await proc.exited;
}
