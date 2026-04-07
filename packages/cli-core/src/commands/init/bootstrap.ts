import { join } from "node:path";
import type { Need } from "../../lib/deps.ts";
import { cyan, yellow } from "../../lib/color.js";
import { throwUserAbort, CliError } from "../../lib/errors.js";
import type { FrameworkInfo } from "../../lib/framework.js";
import { hasPackageJson } from "../../lib/project-detector/index.ts";
import {
  BOOTSTRAP_REGISTRY,
  PM_INSTALL_COMMANDS,
  type PackageManager,
  type BootstrapEntry,
} from "./bootstrap-registry.js";

async function spawnInherited(args: string[], cwd: string): Promise<number> {
  const proc = Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

function findEntry(dep: string) {
  return BOOTSTRAP_REGISTRY.find((entry) => entry.dep === dep);
}

const FRAMEWORK_CHOICES = BOOTSTRAP_REGISTRY.map((entry) => ({
  name: entry.label,
  value: entry.dep,
}));

const PM_CHOICES: Array<{ name: string; value: PackageManager }> = [
  { name: "bun", value: "bun" },
  { name: "pnpm", value: "pnpm" },
  { name: "yarn", value: "yarn" },
  { name: "npm", value: "npm" },
];

function filterChoices<T extends { name: string }>(choices: T[], term: string | undefined): T[] {
  if (!term) return choices;
  const lower = term.toLowerCase();
  return choices.filter((c) => c.name.toLowerCase().includes(lower));
}

type PickFrameworkDeps = Need<{ prompts: "search" }>;

async function pickFramework(
  deps: PickFrameworkDeps,
  frameworkOverride?: FrameworkInfo,
): Promise<BootstrapEntry> {
  if (!frameworkOverride) {
    const chosen = await deps.prompts.search<string>({
      message: "Which framework?",
      source: (term) => filterChoices(FRAMEWORK_CHOICES, term),
    });
    return findEntry(chosen)!;
  }

  const entry = findEntry(frameworkOverride.dep);
  if (entry) return entry;

  const supported = BOOTSTRAP_REGISTRY.map((e) => e.label).join(", ");
  throw new CliError(
    `Bootstrap is not supported for ${frameworkOverride.name}. Supported: ${supported}`,
  );
}

type PickPackageManagerDeps = Need<{ prompts: "search" }>;

async function pickPackageManager(deps: PickPackageManagerDeps): Promise<PackageManager> {
  return deps.prompts.search<PackageManager>({
    message: "Which package manager?",
    source: (term) => filterChoices(PM_CHOICES, term),
  });
}

const PM_PRIORITY: PackageManager[] = ["bun", "pnpm", "yarn", "npm"];

/**
 * Auto-select the first available package manager by priority: bun → pnpm → yarn → npm.
 * Used when running non-interactively (-y / agent mode) and no explicit --pm was given.
 */
export function resolvePackageManager(): PackageManager {
  for (const pm of PM_PRIORITY) {
    if (Bun.which(pm) !== null) return pm;
  }
  return "npm";
}

function validateProjectName(value: string): string | true {
  if (!value.trim()) return "Project name is required";
  if (/[A-Z]/.test(value)) return "Project name must be lowercase";
  if (/\s/.test(value)) return "Project name cannot contain spaces";
  if (value.includes("/") || value.includes(".."))
    return "Project name cannot contain path separators";
  return true;
}

type AskProjectNameDeps = Need<{ prompts: "input" }>;

async function askProjectName(deps: AskProjectNameDeps, entry: BootstrapEntry): Promise<string> {
  const name = await deps.prompts.input({
    message: "Project name:",
    default: entry.defaultProjectName,
    validate: validateProjectName,
  });
  return name.trim();
}

async function generateProject(
  deps: Need<{ log: "info" }>,
  label: string,
  command: string[],
  cwd: string,
): Promise<void> {
  deps.log.info(`\nCreating ${cyan(label)} project...\n`);

  const exitCode = await spawnInherited(command, cwd);
  if (exitCode !== 0) {
    throw new CliError(`Project generation failed (exit code ${exitCode}).`);
  }
}

async function installDependencies(
  deps: Need<{ log: "info" | "warn" }>,
  pm: PackageManager,
  cwd: string,
): Promise<void> {
  deps.log.info(`\nInstalling dependencies...\n`);

  const exitCode = await spawnInherited(PM_INSTALL_COMMANDS[pm], cwd);
  if (exitCode !== 0) {
    deps.log.warn(
      yellow(`Dependency installation failed. Run manually: ${PM_INSTALL_COMMANDS[pm].join(" ")}`),
    );
  }
}

export type ConfirmOverwriteDeps = Need<{ prompts: "confirm" }>;

/**
 * Warn if a package.json already exists (for --starter in non-blank dirs).
 */
export async function confirmOverwrite(deps: ConfirmOverwriteDeps, cwd: string): Promise<void> {
  if (!(await hasPackageJson(cwd))) return;

  const proceed = await deps.prompts.confirm({
    message: "This directory already has a package.json. Proceed anyway?",
    default: false,
  });
  if (!proceed) throwUserAbort();
}

export type AskSkipAuthDeps = Need<{ prompts: "confirm" }>;

export async function askSkipAuth(deps: AskSkipAuthDeps): Promise<boolean> {
  return deps.prompts.confirm({
    message:
      "Skip authentication for now? (you can connect your Clerk account later with `clerk auth login`)",
    default: true,
  });
}

export type BootstrapOverrides = {
  skipConfirm: boolean;
  pmOverride?: PackageManager;
  nameOverride?: string;
};

export type BootstrapResult = {
  projectDir: string;
  projectName: string;
  packageManager: PackageManager;
};

export type PromptAndBootstrapDeps = Need<{
  prompts: "confirm" | "search" | "input";
  log: "info" | "warn";
}>;

/**
 * Interactive bootstrap flow.
 * When skipConfirm is true (e.g. --starter flag, -y, or agent mode), skips the
 * "create a new one?" prompt and auto-resolves PM/project name when not overridden.
 */
export async function promptAndBootstrap(
  deps: PromptAndBootstrapDeps,
  cwd: string,
  frameworkOverride: FrameworkInfo | undefined,
  { skipConfirm = false, pmOverride, nameOverride }: BootstrapOverrides = { skipConfirm: false },
): Promise<BootstrapResult> {
  if (!skipConfirm) {
    const wantBootstrap = await deps.prompts.confirm({
      message: "No project detected. Would you like to create a new one?",
      default: true,
    });
    if (!wantBootstrap) throwUserAbort();
  }

  const entry = await pickFramework(deps, frameworkOverride);
  const pm = await pickPackageManager(deps);
  const projectName = await askProjectName(deps, entry);
  const projectDir = join(cwd, projectName);

  await generateProject(deps, entry.label, entry.buildCommand(pm, projectName), cwd);

  if (!(await hasPackageJson(projectDir))) {
    throw new CliError("Generator did not create a package.json.");
  }

  await installDependencies(deps, pm, projectDir);

  deps.log.info("");
  return { projectDir, projectName, packageManager: pm };
}
