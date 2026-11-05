import { existsSync } from "node:fs";
import { join } from "node:path";
import { text } from "../../../lib/prompts.ts";
import { select } from "../../../lib/listage.ts";
import { log } from "../../../lib/log.ts";
import { CliError, ERROR_CODE } from "../../../lib/errors.ts";
import { StarterInputRequired } from "../native/starter-input.ts";
import { quoteArg } from "../../../lib/json-body.ts";
import { dirExists } from "../context.ts";
import { canSetUpXcode } from "./coordinator.ts";
import { validBundle } from "./identity.ts";
import { compatibleXcode, selectedXcodeFailure } from "./xcode-tools.ts";
import {
  SWIFT_TARGET_NAME,
  TEAM_ID,
  writeStarterProject,
  type ApplePlatform,
} from "./starter-project.ts";
import { readXcodeDefaults, type AppleTeam, type XcodeDefaults } from "./teams.ts";

export const APPLE_STARTERS: { label: string; platform: ApplePlatform }[] = [
  { label: "iOS (SwiftUI)", platform: "ios" },
  { label: "macOS (SwiftUI)", platform: "macos" },
];

/** What the new Xcode project was created with, for the native setup that follows. */
export interface AppleStarter {
  platform: ApplePlatform;
  bundleIdentifier: string;
  teamId: string;
  personalTeam: boolean;
}

export { StarterInputRequired } from "../native/starter-input.ts";

export interface AppleStarterOptions {
  /** Non-interactive: take every answer from flags or Xcode's settings. */
  skipConfirm: boolean;
  /** `--json`: the user names the app, so a missing `--name` is asked for instead of defaulted. */
  requireName?: boolean;
  name?: string;
  bundleId?: string;
  teamId?: string;
  signInWithApple?: boolean;
  /** Runs once every answer is settled, right before the app is written; a throw writes nothing. */
  beforeWrite?: (projectDir: string) => Promise<void>;
}

const DEFAULT_NAME = "MyClerkApp";
const PERSONAL_TEAM_NOTE: Record<ApplePlatform, string> = {
  ios: "A Personal Team runs the app in the simulator. A real device, Associated Domains, and Sign in with Apple need a paid Apple Developer Program team.",
  // A Mac app has no simulator, so it's signed for real; setup leaves Associated Domains out.
  macos:
    "A Personal Team runs the app on this Mac without Associated Domains, so passkeys and password AutoFill stay off. They and Sign in with Apple need a paid Apple Developer Program team.",
};

// The target name becomes the app's module name, so it can't be one the app imports.
const IMPORTED_MODULES = new Set(["Swift", "SwiftUI", "Foundation", "ClerkKit", "ClerkKitUI"]);

function nameProblem(name: string): string | undefined {
  if (!SWIFT_TARGET_NAME.test(name))
    return "App name must start with a letter and use only letters, numbers, and underscores, like MyApp.";
  if (IMPORTED_MODULES.has(name))
    return `${name} is a module the app imports. Pick a different name, like MyApp.`;
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

async function chooseName(cwd: string, options: AppleStarterOptions): Promise<string> {
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

function bundleProblem(value: string): string | undefined {
  return validBundle(value)
    ? undefined
    : "Enter a reverse-DNS Bundle ID of up to 255 characters, like com.example.MyApp.";
}

async function chooseBundleIdentifier(
  name: string,
  options: AppleStarterOptions,
  defaults: XcodeDefaults,
): Promise<string> {
  if (options.bundleId) {
    const problem = bundleProblem(options.bundleId);
    if (problem)
      throw new StarterInputRequired(
        `Invalid --bundle-id "${options.bundleId}": ${problem}`,
        "bundleId",
      );
    return options.bundleId;
  }
  // A Bundle ID allows letters, digits, hyphens, and periods; like Xcode, turn a name's underscores into hyphens.
  const component = name.replace(/_/g, "-");
  const prefixed = defaults.bundleIdentifierPrefix
    ? `${defaults.bundleIdentifierPrefix}.${component}`
    : undefined;
  const suggested = prefixed && !bundleProblem(prefixed) ? prefixed : undefined;
  if (options.skipConfirm) {
    if (suggested) return suggested;
    throw new StarterInputRequired(
      `--bundle-id is required for a new app when Xcode has no usable Organization Identifier. Example: --bundle-id com.example.${component}`,
      "bundleId",
    );
  }
  const value = await text({
    message: "Bundle ID:",
    default: suggested,
    placeholder: suggested ? undefined : `com.example.${component}`,
    validate: (input) => bundleProblem(input?.trim() ?? ""),
  });
  return value.trim();
}

function teamLabel(team: AppleTeam, platform: ApplePlatform): string {
  // Xcode already names a free team like "Sean Perez (Personal Team)".
  const name =
    team.personal && !/personal team/i.test(team.name) ? `${team.name} (Personal Team)` : team.name;
  const limit = platform === "ios" ? " · simulator only" : " · no passkeys or AutoFill";
  return `${name} · ${team.id}${team.personal ? limit : ""}`;
}

async function enterTeamId(): Promise<string> {
  const value = await text({
    message: "Apple Developer Team ID:",
    placeholder: "10 characters, from Xcode › Settings › Accounts",
    validate: (input) =>
      TEAM_ID.test(input?.trim() ?? "")
        ? undefined
        : "Enter the 10-character Team ID from Xcode › Settings › Accounts.",
  });
  return value.trim();
}

const NO_TEAM =
  "No Apple Developer team found in Xcode. Sign in to Xcode with your Apple Account (Xcode › Settings › Accounts), or pass --team-id.";

async function chooseTeam(
  options: AppleStarterOptions,
  teams: AppleTeam[],
  platform: ApplePlatform,
): Promise<AppleTeam> {
  if (options.teamId) {
    const id = options.teamId.trim();
    if (!TEAM_ID.test(id))
      throw new StarterInputRequired(
        `Invalid --team-id "${options.teamId}": use the 10-character Team ID from Xcode › Settings › Accounts.`,
        "teamId",
        // Sign in with Apple can't use a Personal Team, so only teams that could sign it are offered.
        { choices: options.signInWithApple ? teams.filter((team) => !team.personal) : teams },
      );
    return teams.find((team) => team.id === id) ?? { id, name: id, personal: false };
  }
  if (options.skipConfirm) {
    const paid = teams.filter((team) => !team.personal);
    const candidates = paid.length ? paid : teams;
    if (candidates.length === 1) return candidates[0]!;
    throw new StarterInputRequired(
      candidates.length
        ? `Choose the Apple Developer team with --team-id: ${candidates.map((team) => teamLabel(team, platform)).join(", ")}.`
        : NO_TEAM,
      "teamId",
      { choices: candidates },
    );
  }
  if (!teams.length) {
    log.info(NO_TEAM);
    const id = await enterTeamId();
    return { id, name: id, personal: false };
  }
  const choice = await select<AppleTeam | "enter">({
    message: "Apple Developer team:",
    choices: [
      ...teams.map((team) => ({ name: teamLabel(team, platform), value: team })),
      { name: "Enter a Team ID", value: "enter" as const },
    ],
  });
  if (choice !== "enter") return choice;
  const id = await enterTeamId();
  return teams.find((team) => team.id === id) ?? { id, name: id, personal: false };
}

// The Clerk SDK needs Swift 6.2, and setup builds the starter with the selected Xcode, so check
// it before writing anything a too-old Xcode couldn't open.
const MINIMUM_XCODE = 26;

async function assertStarterXcode(): Promise<void> {
  // compatibleXcode leaves a selected Xcode that can't run for setup's xcodebuild to explain,
  // which would come after the starter is written. Only the Command Line Tools are its to handle.
  const failure = await selectedXcodeFailure();
  if (failure && !/command line tools/i.test(failure))
    throw new CliError(
      `The selected Xcode can't run yet: ${failure}\nFix that, then run clerk init --starter again.`,
      { code: ERROR_CODE.BOOTSTRAP_UNSUPPORTED },
    );
  let developerDir: string | undefined;
  try {
    developerDir = await compatibleXcode(MINIMUM_XCODE);
  } catch (error) {
    // Keep the license fix it names for an installed Xcode; its other messages are about existing projects.
    if (error instanceof CliError && /license/i.test(error.message)) throw error;
    throw new CliError(
      `A new iOS or macOS app needs Xcode ${MINIMUM_XCODE} or later. Install it, then run clerk init --starter again.`,
      { code: ERROR_CODE.BOOTSTRAP_UNSUPPORTED },
    );
  }
  if (developerDir)
    throw new CliError(
      `A new iOS or macOS app needs Xcode ${MINIMUM_XCODE} or later as the selected Xcode. Select it with \`sudo xcode-select -s ${quoteArg(developerDir)}\`, then run clerk init --starter again.`,
      { code: ERROR_CODE.BOOTSTRAP_UNSUPPORTED },
    );
}

/**
 * Asks for the new app's name, Bundle ID, and Apple Developer team, then writes a SwiftUI
 * starter that native setup recognizes. Every answer is settled before anything is written.
 */
export async function promptAppleStarter(
  cwd: string,
  platform: ApplePlatform,
  options: AppleStarterOptions,
): Promise<{ projectDir: string; projectName: string; apple: AppleStarter }> {
  if (!canSetUpXcode())
    throw new CliError(
      "A new iOS or macOS app needs Xcode on macOS. Install Xcode, then run clerk init --starter again.",
      { code: ERROR_CODE.BOOTSTRAP_UNSUPPORTED },
    );
  await assertStarterXcode();
  const defaults = readXcodeDefaults();
  const name = await chooseName(cwd, options);
  const projectDir = join(cwd, name);
  if (await dirExists(projectDir))
    throw new StarterInputRequired(
      `Directory '${name}' already exists. Pick a different name or remove it first.`,
      "name",
      {},
      ERROR_CODE.PROJECT_DIR_EXISTS,
    );
  const bundleIdentifier = await chooseBundleIdentifier(name, options, defaults);
  const team = await chooseTeam(options, defaults.teams, platform);
  if (team.personal) {
    if (options.signInWithApple)
      throw new StarterInputRequired(
        "Sign in with Apple needs a paid Apple Developer Program team. Choose a paid team with --team-id, or drop --sign-in-with-apple.",
        "teamId",
        { choices: defaults.teams.filter((candidate) => !candidate.personal) },
      );
    log.info(PERSONAL_TEAM_NOTE[platform]);
  }
  await options.beforeWrite?.(projectDir);

  log.blank();
  log.info(`Creating \`${name}\` ${platform === "ios" ? "iOS" : "macOS"} app...`);
  await writeStarterProject(projectDir, {
    name,
    bundleIdentifier,
    teamId: team.id,
    platform,
  });
  return {
    projectDir,
    projectName: name,
    apple: { platform, bundleIdentifier, teamId: team.id, personalTeam: team.personal },
  };
}
