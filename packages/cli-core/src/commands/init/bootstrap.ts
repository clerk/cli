import { join } from "node:path";
import { statSync } from "node:fs";
import { confirm, text } from "../../lib/prompts.ts";
import { search, filterChoices } from "../../lib/listage.ts";
import { throwUserAbort, throwUsageError, CliError, ERROR_CODE } from "../../lib/errors.js";
import { log } from "../../lib/log.js";
import type { FrameworkInfo } from "../../lib/framework.js";
import { dirExists, hasPackageJson } from "./context.js";
import type { PackageManager } from "../../lib/package-manager.ts";
import {
  BOOTSTRAP_REGISTRY,
  PM_INSTALL_COMMANDS,
  type BootstrapEntry,
} from "./bootstrap-registry.js";
import { canSetUpXcode } from "./ios/coordinator.js";
import { APPLE_STARTERS, promptAppleStarter, type AppleStarter } from "./ios/starter-bootstrap.js";
import type { ApplePlatform } from "./ios/starter-project.js";

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

type StarterChoice =
  | { kind: "npm"; entry: BootstrapEntry }
  | { kind: "apple"; platform: ApplePlatform };

// Native starters write an Xcode project, so they're offered only where native setup can run.
function starterChoices() {
  return canSetUpXcode()
    ? [
        ...FRAMEWORK_CHOICES,
        ...APPLE_STARTERS.map((starter) => ({ name: starter.label, value: starter.platform })),
      ]
    : FRAMEWORK_CHOICES;
}

const PM_CHOICES: Array<{ name: string; value: PackageManager }> = [
  { name: "bun", value: "bun" },
  { name: "pnpm", value: "pnpm" },
  { name: "yarn", value: "yarn" },
  { name: "npm", value: "npm" },
];

async function pickFramework(
  frameworkOverride?: FrameworkInfo,
  applePlatform: ApplePlatform = "ios",
): Promise<StarterChoice> {
  if (!frameworkOverride) {
    const choices = starterChoices();
    const chosen = await search({
      message: "Which framework?",
      source: (term) => filterChoices(choices, term),
    });
    const apple = APPLE_STARTERS.find((starter) => starter.platform === chosen);
    return apple
      ? { kind: "apple", platform: apple.platform }
      : { kind: "npm", entry: findEntry(chosen)! };
  }

  if (frameworkOverride.dep === "ios") return { kind: "apple", platform: applePlatform };
  const entry = findEntry(frameworkOverride.dep);
  if (entry) return { kind: "npm", entry };

  const supported = [
    ...BOOTSTRAP_REGISTRY.map((e) => e.label),
    ...APPLE_STARTERS.map((s) => s.label),
  ].join(", ");
  throw new CliError(
    `Bootstrap is not supported for ${frameworkOverride.name}. Supported: ${supported}`,
    { code: ERROR_CODE.BOOTSTRAP_UNSUPPORTED },
  );
}

async function pickPackageManager(): Promise<PackageManager> {
  return search<PackageManager>({
    message: "Which package manager?",
    source: (term) => filterChoices(PM_CHOICES, term),
  });
}

const PM_PRIORITY = ["bun", "pnpm", "yarn", "npm"] as const satisfies readonly PackageManager[];

// Exhaustiveness guard: breaks the build if a PackageManager variant is
// missing from PM_PRIORITY (the `satisfies` above only ensures each entry
// is a valid PackageManager, not that every variant is present).
type _AllPackageManagersCovered =
  Exclude<PackageManager, (typeof PM_PRIORITY)[number]> extends never
    ? true
    : ["PM_PRIORITY missing:", Exclude<PackageManager, (typeof PM_PRIORITY)[number]>];
const _pmPriorityExhaustive: _AllPackageManagersCovered = true;
void _pmPriorityExhaustive;

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

function dirExistsSync(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function validateProjectName(value: string): string | true {
  if (!value.trim()) return "Project name is required";
  if (/[A-Z]/.test(value)) return "Project name must be lowercase";
  if (/\s/.test(value)) return "Project name cannot contain spaces";
  if (value.includes("/") || value.includes(".."))
    return "Project name cannot contain path separators";
  return true;
}

/**
 * Find an unused project name by appending -2, -3, … until the directory does not exist.
 * Returns the original name when nothing collides.
 */
export async function findAvailableProjectName(cwd: string, base: string): Promise<string> {
  if (!(await dirExists(join(cwd, base)))) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!(await dirExists(join(cwd, candidate)))) return candidate;
  }
  throw new CliError(`Could not find an available project name based on '${base}'.`, {
    code: ERROR_CODE.PROJECT_DIR_EXISTS,
  });
}

async function askProjectName(entry: BootstrapEntry, cwd: string): Promise<string> {
  const defaultName = await findAvailableProjectName(cwd, entry.defaultProjectName);
  const name = await text({
    message: "Project name:",
    default: defaultName,
    validate: (value) => {
      const trimmed = value?.trim() ?? "";
      const valid = validateProjectName(trimmed);
      if (valid !== true) return valid;
      if (dirExistsSync(join(cwd, trimmed))) {
        return `Directory '${trimmed}' already exists. Pick a different name.`;
      }
      return undefined;
    },
  });
  return name.trim();
}

async function generateProject(label: string, command: string[], cwd: string): Promise<void> {
  log.blank();
  log.info(`Creating \`${label}\` project...`);
  log.blank();

  const exitCode = await spawnInherited(command, cwd);
  if (exitCode !== 0) {
    throw new CliError(`Project generation failed (exit code ${exitCode}).`, {
      code: ERROR_CODE.GENERATOR_FAILED,
    });
  }
}

async function installDependencies(pm: PackageManager, cwd: string): Promise<void> {
  log.blank();
  log.info("Installing dependencies...");
  log.blank();

  const exitCode = await spawnInherited(PM_INSTALL_COMMANDS[pm], cwd);
  if (exitCode !== 0) {
    log.blank();
    log.warn(
      `Dependency installation failed. Run manually: \`${PM_INSTALL_COMMANDS[pm].join(" ")}\``,
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

/** iOS and macOS have no accountless setup, so a native starter can't take these flags. */
export function rejectAccountlessApple(flags: readonly string[]): never {
  throwUsageError(
    `${flags.join(", ")} ${flags.length === 1 ? "applies" : "apply"} only to accountless web setup; iOS and macOS apps link a Clerk application instead.`,
  );
}

export type BootstrapOverrides = {
  /** Non-interactive mode: require --framework, auto-resolve PM/name, skip all prompts. */
  skipConfirm: boolean;
  /** User already opted into bootstrapping (e.g. via --starter) — skip the "create a new one?" confirm without implying non-interactive mode. Ignored when `skipConfirm` is true (which already implies implicit bootstrap). */
  implicitBootstrap?: boolean;
  pmOverride?: PackageManager;
  nameOverride?: string;
  /** Accountless-only flags that were passed, which a native iOS or macOS starter can't use. */
  accountlessFlags?: readonly string[];
  /** `--json`: a native starter asks for its name instead of defaulting it. */
  json?: boolean;
  /** Answers for a native iOS or macOS starter; `flags` names the Apple flags that were passed. */
  apple?: {
    platform?: ApplePlatform;
    bundleId?: string;
    teamId?: string;
    signInWithApple?: boolean;
    flags: readonly string[];
  };
};

export type BootstrapResult =
  | { projectDir: string; projectName: string; packageManager: PackageManager; apple?: undefined }
  | { projectDir: string; projectName: string; apple: AppleStarter; packageManager?: undefined };

/**
 * Interactive bootstrap flow.
 * `skipConfirm` means non-interactive: requires --framework and auto-resolves PM/project name.
 * `implicitBootstrap` only skips the initial "create a new one?" confirm — the rest of the flow stays interactive.
 */
export async function promptAndBootstrap(
  cwd: string,
  frameworkOverride: FrameworkInfo | undefined,
  {
    skipConfirm = false,
    implicitBootstrap = false,
    pmOverride,
    nameOverride,
    accountlessFlags = [],
    json,
    apple,
  }: BootstrapOverrides = { skipConfirm: false },
): Promise<BootstrapResult> {
  if (!skipConfirm && !implicitBootstrap) {
    const wantBootstrap = await confirm({
      message: "No project detected. Would you like to create a new one?",
      default: true,
    });
    if (!wantBootstrap) throwUserAbort();
  }

  if (skipConfirm && !frameworkOverride) {
    throwUsageError(
      "Non-interactive mode requires --framework for new projects. Example: clerk init --starter --framework next",
    );
  }

  // A Swift app name follows different rules, so a name for a starter that hasn't been
  // chosen yet is checked once the framework is known.
  const validateName = () => {
    if (!nameOverride) return;
    const valid = validateProjectName(nameOverride);
    if (valid !== true) throwUsageError(`Invalid --name "${nameOverride}": ${valid}`);
  };
  if (frameworkOverride && frameworkOverride.dep !== "ios") validateName();

  const choice = await pickFramework(frameworkOverride, apple?.platform);
  if (choice.kind === "apple") {
    if (accountlessFlags.length) rejectAccountlessApple(accountlessFlags);
    return promptAppleStarter(cwd, choice.platform, {
      skipConfirm,
      requireName: json,
      name: nameOverride,
      bundleId: apple?.bundleId,
      teamId: apple?.teamId,
      signInWithApple: apple?.signInWithApple,
    });
  }
  if (!frameworkOverride) validateName();
  if (apple?.flags.length)
    throwUsageError(
      `${apple.flags.join(", ")} ${apple.flags.length === 1 ? "applies" : "apply"} only to iOS and macOS apps.`,
    );

  const { entry } = choice;
  const pm = pmOverride ?? (skipConfirm ? resolvePackageManager() : await pickPackageManager());
  const projectName =
    nameOverride ??
    (skipConfirm
      ? await findAvailableProjectName(cwd, entry.defaultProjectName)
      : await askProjectName(entry, cwd));
  const projectDir = join(cwd, projectName);

  // `askProjectName` and `findAvailableProjectName` already guarantee an unused dir;
  // this guard only fires for an explicit `--name` collision.
  if (await dirExists(projectDir)) {
    throw new CliError(
      `Directory '${projectName}' already exists. Pick a different name or remove it first.`,
      { code: ERROR_CODE.PROJECT_DIR_EXISTS },
    );
  }

  await generateProject(entry.label, entry.buildCommand(pm, projectName), cwd);

  if (!(await hasPackageJson(projectDir))) {
    throw new CliError("Generator did not create a package.json.", {
      code: ERROR_CODE.GENERATOR_FAILED,
    });
  }

  await installDependencies(pm, projectDir);

  log.blank();
  return { projectDir, projectName, packageManager: pm };
}
