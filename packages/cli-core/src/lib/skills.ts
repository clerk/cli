/**
 * Helpers for invoking the external `skills` CLI.
 *
 * The external `skills` CLI handles agent auto-detection and scope
 * selection: in interactive mode we hand off entirely (no `--agent` / `-y`),
 * so the user gets the native picker. In non-interactive mode we pass
 * `-y -g` so it runs unattended with global scope and auto-detected agents.
 */

import { dim } from "./color.js";
import { log } from "./log.js";
import { select } from "./listage.js";
import {
  type Runner,
  detectAvailableRunners,
  preferredRunner,
  runnerCommand,
  runnerForPackageManager,
} from "./runners.js";
import { isNonEmpty } from "./helpers/arrays.js";
import type { PackageManager } from "./package-manager.js";

/**
 * Build the runner-agnostic argv for `skills add <source> ...`. The caller
 * prepends the runner (bunx / npx / pnpm dlx / yarn dlx) via
 * {@link runnerCommand}.
 *
 * `skillNames` becomes `--skill <name>` pairs; leave empty to install every
 * skill from `source`.
 *
 * Interactive mode: hand off to the skills CLI's native UX (auto-detect
 * installed agents, scope picker) by omitting `--agent` and `-y`.
 * Non-interactive: pass `-y -g` so it runs unattended with global scope
 * and auto-detected agents.
 *
 * Exported for tests.
 */
export function buildSkillsArgs(
  source: string,
  skillNames: readonly string[],
  interactive: boolean,
): string[] {
  const skillFlags = skillNames.flatMap((s) => ["--skill", s]);
  const extraFlags = interactive ? [] : ["-y", "-g"];
  return ["skills", "add", source, ...skillFlags, ...extraFlags];
}

/**
 * Run a single `skills add ...` invocation. Returns true on success, false
 * on any failure (spawn error, non-zero exit). Failures print a yellow
 * warning but never throw, skills are optional and shouldn't tear down
 * a successful scaffold.
 */
export async function runSkillsAdd(
  runner: Runner,
  cwd: string,
  source: string,
  skillNames: readonly string[],
  interactive: boolean,
  label: string,
): Promise<boolean> {
  const command = runnerCommand(runner, "skills", buildSkillsArgs(source, skillNames, interactive));
  const displayCommand = `${runner.display} skills add ${source}`;

  log.blank();
  log.info(`Installing \`${label}\` with \`${runner.display}\`...`);

  let exitCode: number;
  try {
    const proc = Bun.spawn(command, {
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    exitCode = await proc.exited;
  } catch {
    log.blank();
    log.warn(`Could not run \`${displayCommand}\`. You can install manually later.`);
    return false;
  }

  if (exitCode !== 0) {
    log.blank();
    log.warn(`\`${label}\` installation failed. You can install manually: \`${displayCommand}\``);
    return false;
  }

  return true;
}

/**
 * Resolve a runner for the `skills` CLI. Prompts the user to pick one in
 * interactive mode when multiple are available; otherwise picks the
 * preferred runner for `packageManager`.
 *
 * Returns `null` if no runner is on PATH. In that case a warning is logged
 * so the caller can simply return without further output.
 */
export async function resolveSkillsRunner(
  packageManager: PackageManager | undefined,
  interactive: boolean,
): Promise<Runner | null> {
  const available = detectAvailableRunners();
  if (!isNonEmpty(available)) {
    const suggested = runnerForPackageManager(packageManager);
    log.blank();
    log.warn(
      "No package runner found on PATH (looked for bunx, npx, pnpm, yarn). " +
        `Install one and run \`${suggested.display} skills add <source>\` manually.`,
    );
    return null;
  }

  const preferred = preferredRunner(packageManager, available);

  if (interactive && available.length > 1) {
    return await select<Runner>({
      message: "Which package runner should install the skills?",
      choices: available.map((r) => ({
        name: r.id === preferred.id ? `${r.display} ${dim("(detected)")}` : r.display,
        value: r,
      })),
      default: preferred,
    });
  }

  return preferred;
}
