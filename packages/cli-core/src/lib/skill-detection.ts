import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Agents that host skills under the uniform
 * `<agent-dir>/skills/<name>/SKILL.md` layout. Each is checked under
 * both `$HOME/<dir>/skills/clerk-cli/SKILL.md` (global) and
 * `<cwd>/<dir>/skills/clerk-cli/SKILL.md` (project-local).
 */
export const STANDARD_AGENT_DIRS = [
  ".claude", // Claude Code
  ".agents", // generic / shared
  ".codex", // OpenAI Codex CLI
  ".cursor", // Cursor
  ".windsurf", // Windsurf / Codeium
  ".zed", // Zed editor
  ".cline", // Cline VS Code extension
] as const;

const STANDARD_SKILL_REL = "skills/clerk-cli/SKILL.md";

/**
 * Paths for agents that don't follow the uniform
 * `<dir>/skills/<name>/SKILL.md` layout. These are project-local only
 * and are checked under `<cwd>` (not `$HOME`), because
 * `clerk skill install` does not install these layouts globally.
 */
export const EXTRA_REL_PATHS = [
  ".vscode/skills/clerk-cli/SKILL.md", // VS Code (project-local)
  ".github/prompts/clerk-cli.md", // GitHub Copilot (project-local)
] as const;

/**
 * Best-effort synchronous check for whether the bundled `clerk-cli` skill
 * is installed for at least one local agent. Returns `true` on the first
 * hit. A missed match just means the install tip keeps showing — no
 * false positives harm the user.
 */
export function isClerkSkillInstalled(): boolean {
  const home = process.env.HOME ?? homedir();
  const cwd = process.cwd();

  for (const dir of STANDARD_AGENT_DIRS) {
    if (existsSync(join(home, dir, STANDARD_SKILL_REL))) return true;
    if (existsSync(join(cwd, dir, STANDARD_SKILL_REL))) return true;
  }
  for (const rel of EXTRA_REL_PATHS) {
    if (existsSync(join(cwd, rel))) return true;
  }
  return false;
}
