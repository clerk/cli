import { existsSync } from "node:fs";
import { join } from "node:path";
import { text } from "../../../lib/prompts.ts";
import { log } from "../../../lib/log.ts";
import { CliError, ERROR_CODE } from "../../../lib/errors.ts";
import { dirExists } from "../context.ts";
import { StarterInputRequired } from "../native/starter-input.ts";
import { PACKAGE_NAME } from "./gradle.ts";
import { ANDROID_APP_NAME, writeAndroidStarter } from "./starter-project.ts";

export const ANDROID_STARTER = { label: "Android (Jetpack Compose)", value: "android" } as const;

/** What the new Gradle project was created with, for the native setup that follows. */
export interface AndroidStarter {
  applicationId: string;
}

export interface AndroidStarterOptions {
  /** Non-interactive: take every answer from flags or defaults. */
  skipConfirm: boolean;
  /** `--json`: the user names the app, so a missing `--name` is asked for instead of defaulted. */
  requireName?: boolean;
  name?: string;
  /** `--android-package`: the applicationId, which is also the namespace and Kotlin package. */
  applicationId?: string;
  /** Runs once every answer is settled, right before the app is written; a throw writes nothing. */
  beforeWrite?: (projectDir: string) => Promise<void>;
}

const DEFAULT_NAME = "MyClerkApp";
// Kotlin hard keywords can't be package segments; the lowercased name is the default's last one.
const KOTLIN_KEYWORDS = new Set([
  "as",
  "break",
  "class",
  "continue",
  "do",
  "else",
  "false",
  "for",
  "fun",
  "if",
  "in",
  "interface",
  "is",
  "null",
  "object",
  "package",
  "return",
  "super",
  "this",
  "throw",
  "true",
  "try",
  "typealias",
  "typeof",
  "val",
  "var",
  "when",
  "while",
]);

function nameProblem(name: string): string | undefined {
  if (!ANDROID_APP_NAME.test(name))
    return "App name must start with a letter and use only letters, numbers, and underscores, like MyApp.";
  if (KOTLIN_KEYWORDS.has(name.toLowerCase()))
    return `${name} is a Kotlin keyword, so it can't name the app's package. Pick a different name, like MyApp.`;
  return undefined;
}

async function availableName(cwd: string): Promise<string> {
  if (!(await dirExists(join(cwd, DEFAULT_NAME)))) return DEFAULT_NAME;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${DEFAULT_NAME}${i}`;
    if (!(await dirExists(join(cwd, candidate)))) return candidate;
  }
  throw new CliError(`Could not find an available app name based on '${DEFAULT_NAME}'.`, {
    code: ERROR_CODE.PROJECT_DIR_EXISTS,
  });
}

async function chooseName(cwd: string, options: AndroidStarterOptions): Promise<string> {
  if (options.name) {
    const problem = nameProblem(options.name);
    if (problem)
      throw new StarterInputRequired(`Invalid --name "${options.name}": ${problem}`, "name");
    return options.name;
  }
  const suggested = await availableName(cwd);
  if (options.requireName)
    throw new StarterInputRequired("--name is required for a new app with --json.", "name", {
      suggestion: suggested,
    });
  if (options.skipConfirm) return suggested;
  const name = await text({
    message: "App name:",
    default: suggested,
    validate: (value) => {
      const trimmed = value?.trim() ?? "";
      return (
        nameProblem(trimmed) ??
        (existsSync(join(cwd, trimmed))
          ? `Directory '${trimmed}' already exists. Pick a different name.`
          : undefined)
      );
    },
  });
  return name.trim();
}

function packageProblem(value: string): string | undefined {
  if (!PACKAGE_NAME.test(value))
    return "Enter a reverse-DNS applicationId with at least two segments, like com.example.myapp.";
  if (value.split(".").some((segment) => KOTLIN_KEYWORDS.has(segment)))
    return "An applicationId segment can't be a Kotlin keyword, since it's also the Kotlin package.";
  return undefined;
}

/** Android Studio's default: `com.example.` plus the lowercased app name. */
export const defaultApplicationId = (name: string) => `com.example.${name.toLowerCase()}`;

async function chooseApplicationId(name: string, options: AndroidStarterOptions): Promise<string> {
  if (options.applicationId) {
    const problem = packageProblem(options.applicationId);
    if (problem)
      throw new StarterInputRequired(
        `Invalid --android-package "${options.applicationId}": ${problem}`,
        "androidPackage",
      );
    return options.applicationId;
  }
  const suggested = defaultApplicationId(name);
  if (options.skipConfirm) return suggested;
  const value = await text({
    message: "Application ID (package name):",
    default: suggested,
    validate: (input) => packageProblem(input?.trim() ?? ""),
  });
  return value.trim();
}

/**
 * Asks for the new app's name and applicationId, then writes a Jetpack Compose starter that native
 * setup recognizes. Every answer is settled before anything is written. No toolchain is needed to
 * write it; the Android SDK and a JDK are needed to build it.
 */
export async function promptAndroidStarter(
  cwd: string,
  options: AndroidStarterOptions,
): Promise<{ projectDir: string; projectName: string; android: AndroidStarter }> {
  const name = await chooseName(cwd, options);
  const projectDir = join(cwd, name);
  if (await dirExists(projectDir))
    throw new StarterInputRequired(
      `Directory '${name}' already exists. Pick a different name or remove it first.`,
      "name",
      {},
      ERROR_CODE.PROJECT_DIR_EXISTS,
    );
  const applicationId = await chooseApplicationId(name, options);
  await options.beforeWrite?.(projectDir);

  log.blank();
  log.info(`Creating \`${name}\` Android app...`);
  await writeAndroidStarter(projectDir, { name, applicationId });
  return { projectDir, projectName: name, android: { applicationId } };
}
