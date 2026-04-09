import { join } from "node:path";
import { search, confirm, input } from "@inquirer/prompts";
import { cyan, yellow } from "../../lib/color.js";
import { throwUserAbort, CliError } from "../../lib/errors.js";
import type { FrameworkInfo } from "../../lib/framework.js";
import { hasPackageJson } from "./context.js";
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

async function pickFramework(frameworkOverride?: FrameworkInfo): Promise<BootstrapEntry> {
  if (!frameworkOverride) {
    const chosen = await search({
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

async function pickPackageManager(): Promise<PackageManager> {
  return search<PackageManager>({
    message: "Which package manager?",
    source: (term) => filterChoices(PM_CHOICES, term),
  });
}

function defaultProjectName(entry: BootstrapEntry): string {
  return entry.defaultProjectName;
}

async function askProjectName(entry: BootstrapEntry): Promise<string> {
  const name = await input({
    message: "Project name:",
    default: defaultProjectName(entry),
    validate: (value) => {
      if (!value.trim()) return "Project name is required";
      if (/[A-Z]/.test(value)) return "Project name must be lowercase";
      if (/\s/.test(value)) return "Project name cannot contain spaces";
      if (value.includes("/") || value.includes(".."))
        return "Project name cannot contain path separators";
      return true;
    },
  });
  return name.trim();
}

async function generateProject(label: string, command: string[], cwd: string): Promise<void> {
  console.log(`\nCreating ${cyan(label)} project...\n`);

  const exitCode = await spawnInherited(command, cwd);
  if (exitCode !== 0) {
    throw new CliError(`Project generation failed (exit code ${exitCode}).`);
  }
}

async function installDependencies(pm: PackageManager, cwd: string): Promise<void> {
  console.log(`\nInstalling dependencies...\n`);

  const exitCode = await spawnInherited(PM_INSTALL_COMMANDS[pm], cwd);
  if (exitCode !== 0) {
    console.log(
      yellow(
        `\nDependency installation failed. Run manually: ${PM_INSTALL_COMMANDS[pm].join(" ")}`,
      ),
    );
  }
}

/**
 * Warn if a package.json already exists (for --starter in non-blank dirs).
 */
export async function confirmOverwrite(cwd: string): Promise<void> {
  if (!(await hasPackageJson(cwd))) return;

  const proceed = await confirm({
    message: "This directory already has a package.json. Proceed anyway?",
    default: false,
  });
  if (!proceed) throwUserAbort();
}

export async function askSkipAuth(): Promise<boolean> {
  return confirm({
    message:
      "Skip authentication for now? (you can connect your Clerk account later with `clerk auth login`)",
    default: true,
  });
}

export type BootstrapResult = {
  projectDir: string;
  projectName: string;
  packageManager: PackageManager;
};

/**
 * Interactive bootstrap flow.
 * When skipConfirm is true (e.g. --starter flag), skips the "create a new one?" prompt.
 * Returns bootstrap result on success, or null on failure.
 */
export async function promptAndBootstrap(
  cwd: string,
  frameworkOverride?: FrameworkInfo,
  { skipConfirm = false } = {},
): Promise<BootstrapResult> {
  if (!skipConfirm) {
    const wantBootstrap = await confirm({
      message: "No project detected. Would you like to create a new one?",
      default: true,
    });
    if (!wantBootstrap) throwUserAbort();
  }

  const entry = await pickFramework(frameworkOverride);
  const pm = await pickPackageManager();
  const projectName = await askProjectName(entry);
  const projectDir = join(cwd, projectName);

  await generateProject(entry.label, entry.buildCommand(pm, projectName), cwd);

  if (!(await hasPackageJson(projectDir))) {
    throw new CliError("Generator did not create a package.json.");
  }

  await installDependencies(pm, projectDir);

  console.log();
  return { projectDir, projectName, packageManager: pm };
}
