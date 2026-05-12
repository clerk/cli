/**
 * Helpers for interacting with the 1Password CLI (`op`).
 *
 * Secrets are resolved in-memory via `op read` and never written to disk.
 */

import { $ } from "bun";

const TEAM_CLERK_ACCOUNT = "team-clerk";

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
 * Finds the number of 1Password accounts available locally.
 *
 * @returns `0` if `op` is missing, the command fails, or the output is not a JSON array.
 */
async function getOpAccountCount(): Promise<number> {
  const res = await $`op account list --format json`
    .env({ ...process.env })
    .quiet()
    .nothrow();

  if (res.exitCode !== 0) {
    return 0;
  }

  try {
    const parsed: unknown = JSON.parse(res.stdout.toString());
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Gets the 1Password account to use for the current operation.
 *
 * @returns the team-clerk account if there are multiple accounts, otherwise an empty string.
 */
async function getOpAccount(): Promise<string> {
  const opAccountCount = await getOpAccountCount();
  return opAccountCount > 1 ? TEAM_CLERK_ACCOUNT : "";
}

/**
 * Read a secret or document from 1Password by `op://` reference.
 * Throws with a helpful hint if the read fails.
 */
export async function readOpItem(reference: string): Promise<string> {
  const OP_ACCOUNT = await getOpAccount();
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

  const OP_ACCOUNT = await getOpAccount();
  const proc = Bun.spawn(["op", "run", "--", ...command], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, OP_ACCOUNT, ...references },
  });

  return await proc.exited;
}
