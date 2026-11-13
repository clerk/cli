import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { selectApplication, type ChooseApp } from "./discovery.ts";
import { configurationNames } from "./project.ts";
import { type FileSnapshot } from "./files.ts";
import { selectedSettings, settingsCommand, type Selection, type SetupInput } from "./plan.ts";
import { compatibleXcode } from "./xcode-tools.ts";
import { CliError, ERROR_CODE, errorMessage } from "../../../lib/errors.ts";
import { setupError, type IOSNativePlatform, type IOSNativeTargetPlatform } from "./types.ts";

export type CommandRunner = (
  command: string[],
  root: string,
  signal?: AbortSignal,
) => Promise<string>;

/** An xcodebuild failure that carries the end of Xcode's own explanation. */
export class XcodeCommandError extends CliError {
  constructor(
    message: string,
    readonly stderr = "",
  ) {
    // Package URLs can embed credentials (https://user:token@host/...).
    const tail = stderr
      .trim()
      .split("\n")
      .slice(-12)
      .join("\n")
      .replace(/:\/\/[^\s/@]+@/g, "://***@");
    super(tail ? `${message}\n\nXcode reported:\n${tail}` : message, {
      code: ERROR_CODE.IOS_SETUP_BLOCKED,
    });
  }
}

export const runCommand: CommandRunner = async (command, root, signal) => {
  signal?.throwIfAborted();
  const project = command[command.indexOf("-project") + 1];
  // JSON projects need Xcode 27; any project needs a full Xcode, not the Command Line Tools.
  const developerDir =
    command[0] === "xcodebuild" && project
      ? await compatibleXcode(
          (await Bun.file(join(root, project, "project.xcproj")).exists()) ? 27 : 1,
          signal,
        )
      : undefined;
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn(command, {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: command.includes("-resolvePackageDependencies") ? 600_000 : 30_000,
      signal,
      env: developerDir ? { ...process.env, DEVELOPER_DIR: developerDir } : process.env,
    });
  } catch (error) {
    throw new XcodeCommandError(
      `Xcode could not start (${errorMessage(error)}). Install Xcode and select it with xcode-select, or use the manual setup instructions.`,
    );
  }
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 8_000_000)
          throw new XcodeCommandError("Xcode returned more output than this setup can inspect.");
        chunks.push(item.value);
      }
      return Buffer.concat(chunks).toString("utf8");
    } catch (error) {
      child.kill();
      throw error;
    } finally {
      reader.releaseLock();
    }
  };
  try {
    const [output, stderr, code] = await Promise.all([
      read(child.stdout),
      read(child.stderr),
      child.exited,
    ]);
    signal?.throwIfAborted();
    if (child.signalCode)
      throw new XcodeCommandError(`\`${command.join(" ")}\` was stopped or timed out.`, stderr);
    if (code !== 0)
      throw new XcodeCommandError(`\`${command.join(" ")}\` exited with code ${code}.`, stderr);
    return output;
  } catch (error) {
    child.kill();
    await child.exited;
    signal?.throwIfAborted();
    if (error instanceof XcodeCommandError) throw error;
    throw new XcodeCommandError(`\`${command.join(" ")}\` failed: ${errorMessage(error)}`);
  }
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface InspectOptions {
  root: string;
  project?: string;
  target?: string;
  chooseApp?: ChooseApp;
  resolvePackages?: boolean;
  progress?: (message: string) => void;
  configuration?: string;
  sdk?: Selection["sdk"];
  products: "core" | "ui";
  minimumVersion: string;
  signal?: AbortSignal;
}

export interface Inspection {
  input: SetupInput;
  document: FileSnapshot;
  settings: Record<string, string>;
  /** Configuration-major, iOS before macOS: a Multiplatform target has one context per configuration and platform. */
  contexts: { selection: Selection; settingsJSON: string; settings: Record<string, string> }[];
  uncheckedConfigurations: string[];
  /** Every target's resolved settings in the unchecked configurations, for ownership checks; undefined when Xcode couldn't report them. */
  uncheckedSettingsJSON: string[] | undefined;
  /** Platforms the target also builds for that Clerk doesn't set up, such as visionOS. */
  unsupportedPlatforms: string[];
  /** A Multiplatform target's settings without `-sdk`, so ownership checks also see each other target's own platform. */
  platformNeutralSettingsJSON: string[];
}

const PLATFORM_NAMES: Record<string, string> = {
  iphoneos: "iOS",
  iphonesimulator: "iOS",
  macosx: "macOS",
  xros: "visionOS",
  xrsimulator: "visionOS",
  appletvos: "tvOS",
  appletvsimulator: "tvOS",
  watchos: "watchOS",
  watchsimulator: "watchOS",
  driverkit: "DriverKit",
};

/** The Apple platforms the inspected contexts cover, iOS first. */
export function inspectedPlatforms(inspection: Pick<Inspection, "contexts">): IOSNativePlatform[] {
  const sdks = new Set(inspection.contexts.map((context) => context.selection.sdk));
  return [
    ...(sdks.has("iphoneos") || sdks.has("iphonesimulator") ? (["ios"] as const) : []),
    ...(sdks.has("macosx") ? (["macos"] as const) : []),
  ];
}

export function nativePlatform(inspection: Pick<Inspection, "contexts">): IOSNativeTargetPlatform {
  const platforms = inspectedPlatforms(inspection);
  return platforms.length > 1 ? "multiplatform" : platforms[0]!;
}

export function platformLabel(platform: IOSNativePlatform | Selection["sdk"]): "iOS" | "macOS" {
  return platform === "macos" || platform === "macosx" ? "macOS" : "iOS";
}

/** "iOS", "macOS", or "iOS and macOS" for a Multiplatform target. */
export function platformsLabel(inspection: Pick<Inspection, "contexts">): string {
  return inspectedPlatforms(inspection).map(platformLabel).join(" and ");
}

/** How checks name a context: the configuration, plus the platform when the target builds for both. */
export function contextLabel(
  inspection: Pick<Inspection, "contexts">,
  context: Pick<Inspection["contexts"][number], "selection">,
): string {
  const { configuration, sdk } = context.selection;
  return inspectedPlatforms(inspection).length > 1
    ? `${configuration} (${platformLabel(sdk)})`
    : configuration;
}

async function generator(root: string, project: string): Promise<SetupInput["managedBy"]> {
  const paths = relative(root, join(root, project)).split(/[\\/]/).slice(0, -1);
  for (let depth = paths.length; depth >= 0; depth--) {
    const directory = join(root, ...paths.slice(0, depth));
    const names = new Set((await readdir(directory)).map(String));
    if (names.has("project.yml")) return "xcodegen";
    if (names.has("Project.swift") || names.has("Workspace.swift") || names.has("Tuist"))
      return "tuist";
  }
  return "xcode";
}

export async function inspectSelectedProject(
  options: InspectOptions,
  run: CommandRunner = runCommand,
): Promise<Inspection> {
  options.signal?.throwIfAborted();
  const root = await realpath(options.root);
  const supplied =
    options.project && isAbsolute(options.project)
      ? relative(resolve(options.root), options.project)
      : options.project;
  const chosen = await selectApplication(root, supplied, options.target, options.chooseApp);
  const { project, document, format: projectFormat } = chosen;
  const target = { id: chosen.targetId, name: chosen.targetName };
  const declared = configurationNames(document.source, projectFormat, target.id);
  if (!declared.length || new Set(declared).size !== declared.length)
    throw setupError("The selected target must declare unambiguous build configurations.");
  const configurations = options.configuration
    ? [options.configuration]
    : ["Debug", "Release"].filter((name) => declared.includes(name));
  if (!configurations.length || configurations.some((name) => !declared.includes(name)))
    throw setupError("Choose a declared --xcode-configuration explicitly.");
  const contexts: Inspection["contexts"] = [];
  const unsupportedPlatforms = new Set<string>();
  const platformNeutralSettingsJSON: string[] = [];
  let resolved = false;
  const readSettings = async (selection: Selection, sdk: boolean) => {
    const command = settingsCommand(selection);
    if (!sdk) command.splice(command.indexOf("-sdk"), 2);
    let output: string;
    try {
      output = await run(command, root, options.signal);
    } catch (error) {
      // Only a missing package checkout is fixed by resolving packages; anything
      // else (license, Command Line Tools, a broken project) would just retry.
      const needsPackages = error instanceof XcodeCommandError && /package/i.test(error.stderr);
      if (!options.resolvePackages || resolved || !needsPackages || options.signal?.aborted)
        throw error;
      await resolvePackages(root, project, run, options.signal, options.progress);
      resolved = true;
      output = await run(command, root, options.signal);
    }
    let rows: unknown;
    try {
      rows = JSON.parse(output);
    } catch {
      throw setupError("Xcode did not return valid settings JSON.");
    }
    // Xcode may spell /private/var as /var on macOS; compare filesystem identity,
    // for every target, since ownership checks compare their paths too.
    for (const item of Array.isArray(rows) ? rows : []) {
      const settings = object(item) && object(item.buildSettings) ? item.buildSettings : undefined;
      for (const key of ["PROJECT_FILE_PATH", "SRCROOT"])
        if (typeof settings?.[key] === "string") settings[key] = await realpath(settings[key]);
    }
    const row = Array.isArray(rows)
      ? rows.find((item) => object(item) && item.target === target.name)
      : undefined;
    return {
      settingsJSON: JSON.stringify(rows),
      reported: object(row) && object(row.buildSettings) ? row.buildSettings : undefined,
    };
  };
  const addContext = (selection: Selection, settingsJSON: string) =>
    contexts.push({ selection, settingsJSON, settings: selectedSettings(selection, settingsJSON) });
  for (const configuration of configurations) {
    const selection: Selection = {
      root,
      project,
      targetId: target.id,
      targetName: target.name,
      configuration,
      sdk: options.sdk ?? "iphoneos",
    };
    const { settingsJSON, reported } = await readSettings(selection, options.sdk !== undefined);
    const sdk = reported?.PLATFORM_NAME;
    if (options.sdk || sdk === "iphoneos" || sdk === "iphonesimulator" || sdk === "macosx") {
      if (!options.sdk) selection.sdk = sdk as Selection["sdk"];
      addContext(selection, settingsJSON);
      continue;
    }
    // A Multiplatform target (SDKROOT = auto) resolves to no platform until one is chosen,
    // so inspect each Apple platform it lists that Clerk sets up.
    const listed =
      sdk === undefined && typeof reported?.SUPPORTED_PLATFORMS === "string"
        ? reported.SUPPORTED_PLATFORMS.split(/\s+/).filter(Boolean)
        : [];
    const platforms = [
      ...(listed.includes("iphoneos")
        ? (["iphoneos"] as const)
        : listed.includes("iphonesimulator")
          ? (["iphonesimulator"] as const)
          : []),
      ...(listed.includes("macosx") ? (["macosx"] as const) : []),
    ];
    if (!platforms.length)
      throw setupError("Select an iOS or macOS build context; this platform needs manual setup.");
    for (const name of listed)
      if (!["iphoneos", "iphonesimulator", "macosx"].includes(name))
        unsupportedPlatforms.add(PLATFORM_NAMES[name] ?? name);
    platformNeutralSettingsJSON.push(settingsJSON);
    for (const platform of platforms) {
      const context = { ...selection, sdk: platform };
      addContext(context, (await readSettings(context, true)).settingsJSON);
    }
  }
  const platformsOf = (configuration: string) =>
    contexts
      .filter((context) => context.selection.configuration === configuration)
      .map((context) => context.selection.sdk)
      .join(" ");
  if (new Set(configurations.map(platformsOf)).size !== 1)
    throw setupError(
      "Configurations resolve to different platforms; inspect them separately with --xcode-configuration.",
    );
  const { selection, settingsJSON, settings } = contexts[0]!;
  const uncheckedConfigurations = declared.filter((name) => !configurations.includes(name));
  // Another target may use the app's entitlements only in a configuration that wasn't selected.
  let uncheckedSettingsJSON: string[] | undefined = [];
  for (const configuration of uncheckedConfigurations) {
    // No -sdk: each target resolves for its own platform, so SDK-conditional entitlements stay visible.
    const command = settingsCommand({ ...selection, configuration });
    command.splice(command.indexOf("-sdk"), 2);
    try {
      const output = await run(command, root, options.signal);
      JSON.parse(output);
      uncheckedSettingsJSON.push(output);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      uncheckedSettingsJSON = undefined;
      break;
    }
  }
  return {
    document,
    settings,
    contexts,
    uncheckedConfigurations,
    uncheckedSettingsJSON,
    unsupportedPlatforms: [...unsupportedPlatforms],
    platformNeutralSettingsJSON,
    input: {
      selection,
      settingsJSON,
      projectSource: document.source,
      managedBy: await generator(root, project),
      projectFormat,
      products: options.products,
      minimumVersion: options.minimumVersion,
    },
  };
}

export async function resolvePackages(
  root: string,
  project: string,
  run: CommandRunner = runCommand,
  signal?: AbortSignal,
  progress?: (message: string) => void,
): Promise<void> {
  const message = "Resolving Swift packages with Xcode (downloads may take a few minutes)...";
  progress?.(message);
  const timer = progress ? setInterval(() => progress(message), 15_000) : undefined;
  try {
    await run(["xcodebuild", "-resolvePackageDependencies", "-project", project], root, signal);
    progress?.("Swift packages resolved.");
  } catch (error) {
    signal?.throwIfAborted();
    throw new XcodeCommandError(
      "Swift package resolution failed. Check network access and private-package credentials in Xcode, then retry. Project edits and downloaded packages may remain.",
      error instanceof XcodeCommandError ? error.stderr : errorMessage(error),
    );
  } finally {
    clearInterval(timer);
  }
}
