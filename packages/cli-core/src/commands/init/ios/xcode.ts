import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { selectApplication, type ChooseApp } from "./discovery.ts";
import { configurationNames } from "./project.ts";
import { type FileSnapshot } from "./files.ts";
import { selectedSettings, settingsCommand, type Selection, type SetupInput } from "./plan.ts";
import { compatibleXcode } from "./xcode-tools.ts";

export type CommandRunner = (
  command: string[],
  root: string,
  signal?: AbortSignal,
) => Promise<string>;

export const runCommand: CommandRunner = async (command, root, signal) => {
  signal?.throwIfAborted();
  const project = command[command.indexOf("-project") + 1];
  const developerDir =
    command[0] === "xcodebuild" &&
    project &&
    (await Bun.file(join(root, project, "project.xcproj")).exists())
      ? await compatibleXcode(signal)
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
  } catch {
    throw new Error(
      "Xcode could not start. Install/select Xcode or use the manual setup instructions.",
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
          throw new Error("Xcode returned more output than this setup can inspect.");
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
    const [output, , code] = await Promise.all([
      read(child.stdout),
      read(child.stderr),
      child.exited,
    ]);
    signal?.throwIfAborted();
    if (code !== 0)
      throw new Error(
        "Xcode could not inspect this configuration. Open the project, resolve its packages, and retry; manual setup remains available.",
      );
    return output;
  } catch {
    child.kill();
    await child.exited;
    signal?.throwIfAborted();
    throw new Error(
      "Xcode inspection failed or timed out. Resolve the project in Xcode or use manual setup.",
    );
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
  contexts: { selection: Selection; settingsJSON: string; settings: Record<string, string> }[];
  uncheckedConfigurations: string[];
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
    throw new Error("The selected target must declare unambiguous build configurations.");
  const configurations = options.configuration
    ? [options.configuration]
    : ["Debug", "Release"].filter((name) => declared.includes(name));
  if (!configurations.length || configurations.some((name) => !declared.includes(name)))
    throw new Error("Choose a declared --configuration explicitly.");
  const contexts: Inspection["contexts"] = [];
  let resolved = false;
  for (const configuration of configurations) {
    const selection: Selection = {
      root,
      project,
      targetId: target.id,
      targetName: target.name,
      configuration,
      sdk: options.sdk ?? "iphoneos",
    };
    const command = settingsCommand(selection);
    if (!options.sdk) command.splice(command.indexOf("-sdk"), 2);
    let output: string;
    try {
      output = await run(command, root, options.signal);
    } catch (error) {
      if (!options.resolvePackages || resolved || options.signal?.aborted) throw error;
      await resolvePackages(root, project, run, options.signal, options.progress);
      resolved = true;
      output = await run(command, root, options.signal);
    }
    let rows: unknown;
    try {
      rows = JSON.parse(output);
    } catch {
      throw new Error("Xcode did not return valid settings JSON.");
    }
    const row = Array.isArray(rows)
      ? rows.find((item) => object(item) && item.target === target.name)
      : undefined;
    const reported = object(row) && object(row.buildSettings) ? row.buildSettings : undefined;
    if (reported && typeof reported.PROJECT_FILE_PATH === "string") {
      // Xcode may spell /private/var as /var on macOS; compare filesystem identity.
      reported.PROJECT_FILE_PATH = await realpath(reported.PROJECT_FILE_PATH);
    }
    if (reported && typeof reported.SRCROOT === "string")
      reported.SRCROOT = await realpath(reported.SRCROOT);
    const settingsJSON = JSON.stringify(rows);
    if (!options.sdk) {
      const sdk = reported?.PLATFORM_NAME;
      if (sdk !== "iphoneos" && sdk !== "iphonesimulator" && sdk !== "macosx")
        throw new Error("Select an iOS or macOS build context; this platform needs manual setup.");
      selection.sdk = sdk;
    }
    const settings = selectedSettings(selection, settingsJSON);
    contexts.push({ selection, settingsJSON, settings });
  }
  if (new Set(contexts.map((context) => context.selection.sdk)).size !== 1)
    throw new Error(
      "Configurations resolve to different platforms; inspect them separately with --configuration.",
    );
  const { selection, settingsJSON, settings } = contexts[0]!;
  return {
    document,
    settings,
    contexts,
    uncheckedConfigurations: declared.filter((name) => !configurations.includes(name)),
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
  } catch {
    throw new PackageResolutionError(
      "Swift package resolution failed or was cancelled. Check network access and private-package credentials in Xcode, then retry. Project edits and downloaded packages may remain.",
    );
  } finally {
    clearInterval(timer);
  }
}

export class PackageResolutionError extends Error {}
