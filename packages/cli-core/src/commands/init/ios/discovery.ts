import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { parse } from "@bacons/xcode/json";
import { parseXCProjSource, xcprojTargets } from "./xcproj.ts";
import { containedPath, snapshotFile, type FileSnapshot } from "./files.ts";
import { setupError } from "./types.ts";
import { CliError, ERROR_CODE, EXIT_CODE } from "../../../lib/errors.ts";

interface AppChoice {
  project: string;
  targetId: string;
  targetName: string;
}
export type ChooseApp = (choices: AppChoice[]) => Promise<AppChoice>;
export class SelectionNeeded extends CliError {
  constructor(public choices: AppChoice[]) {
    super(
      `Choose an app with --xcode-project / --xcode-target: ${choices.map((choice) => `${choice.targetName} (${choice.project})`).join(", ") || "none found"}.`,
      { code: ERROR_CODE.USAGE_ERROR, exitCode: EXIT_CODE.USAGE },
    );
  }
}

async function workspaceProjects(root: string, workspace: string): Promise<string[]> {
  const source = (await snapshotFile(root, join(workspace, "contents.xcworkspacedata"))).source;
  if (source.length > 2_000_000 || /<!ENTITY|<!DOCTYPE/i.test(source))
    throw setupError("Unsupported workspace XML.");
  const xml = new DOMParser({
    errorHandler: () => {
      throw setupError("Invalid workspace XML.");
    },
  }).parseFromString(source, "text/xml");
  if (xml.documentElement.tagName !== "Workspace")
    throw setupError("Unsupported workspace document.");
  const base = resolve(root, dirname(workspace));
  const result: string[] = [];
  const visit = async (node: typeof xml.documentElement, group: string): Promise<void> => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1) continue;
      const element = child as typeof node;
      if (!["FileRef", "Group"].includes(element.tagName))
        throw setupError("Unsupported workspace reference; select --xcode-project explicitly.");
      const location = element.getAttribute("location") || "group:";
      const colon = location.indexOf(":");
      const kind = location.slice(0, colon),
        path = location.slice(colon + 1);
      if (!["group", "container", "absolute"].includes(kind))
        throw setupError("Unsupported workspace location; select --xcode-project explicitly.");
      const destination = resolve(kind === "container" ? base : group, path);
      if (kind === "absolute" && !isAbsolute(path))
        throw setupError("Invalid absolute workspace reference.");
      let contained: string;
      try {
        contained =
          element.tagName === "Group" && destination === root
            ? root
            : await containedPath(root, destination);
      } catch (error) {
        // Missing, outside-the-root, or symlinked projects can't be edited here; skip them.
        if (element.tagName === "FileRef") continue;
        throw error;
      }
      if (element.tagName === "Group") await visit(element, contained);
      else if (contained.endsWith(".xcodeproj")) result.push(relative(root, contained));
      else if (contained.endsWith(".xcworkspace"))
        throw setupError("Nested workspaces require an explicit --xcode-project selection.");
    }
  };
  await visit(xml.documentElement, base);
  return result;
}

export async function selectApplication(
  root: string,
  supplied?: string,
  target?: string,
  choose?: ChooseApp,
) {
  let projects: string[];
  if (supplied?.endsWith(".xcworkspace"))
    projects = await workspaceProjects(root, relative(root, await containedPath(root, supplied)));
  else if (supplied?.endsWith(".xcodeproj"))
    projects = [relative(root, await containedPath(root, supplied))];
  else if (supplied) throw setupError("Select an .xcodeproj or .xcworkspace directory.");
  else {
    const entries = await readdir(root, { withFileTypes: true });
    projects = entries
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".xcodeproj"))
      .map((entry) => entry.name);
    // A workspace that can't be read must not hide the projects found beside it.
    for (const workspace of entries.filter(
      (entry) => entry.isDirectory() && entry.name.endsWith(".xcworkspace"),
    ))
      projects.push(...(await workspaceProjects(root, workspace.name).catch(() => [])));
  }
  const candidates: (AppChoice & { document: FileSnapshot; format: "pbxproj" | "xcproj" })[] = [];
  for (const project of new Set(projects)) {
    const documents = (await readdir(join(root, project))).filter((name) =>
      ["project.pbxproj", "project.xcproj"].includes(name),
    );
    if (documents.length !== 1)
      throw setupError(
        `Select --xcode-project explicitly; ${project} has no unambiguous project document.`,
      );
    const document = await snapshotFile(root, join(project, documents[0]!));
    const format = documents[0] === "project.pbxproj" ? "pbxproj" : "xcproj";
    let targets: { id: string; name: string }[];
    if (format === "xcproj")
      targets = xcprojTargets(parseXCProjSource(document.source).root).filter((item) =>
        ["application", "com.apple.product-type.application"].includes(item.productType ?? ""),
      );
    else {
      const graph = parse(document.source),
        objects = graph.objects as Record<string, any>;
      targets = (objects[graph.rootObject!]?.targets ?? []).flatMap((id: string) => {
        const item = objects[id];
        return item?.isa === "PBXNativeTarget" &&
          item.productType === "com.apple.product-type.application" &&
          typeof item.name === "string"
          ? [{ id, name: item.name }]
          : [];
      });
    }
    for (const item of targets)
      if (!target || item.id === target || item.name === target)
        candidates.push({ project, targetId: item.id, targetName: item.name, document, format });
  }
  if (candidates.length === 1) return candidates[0]!;
  const choices = candidates.map(({ project, targetId, targetName }) => ({
    project,
    targetId,
    targetName,
  }));
  if (!choose || !choices.length) throw new SelectionNeeded(choices);
  const picked = await choose(choices);
  const matches = candidates.filter(
    (item) => item.project === picked.project && item.targetId === picked.targetId,
  );
  if (matches.length !== 1) throw new SelectionNeeded(choices);
  return matches[0]!;
}
