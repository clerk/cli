import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { resolveXcodeProjectDocument } from "./project-document.ts";

describe("resolveXcodeProjectDocument", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function project(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "clerk-xcode-document-"));
    roots.push(root);
    const path = join(root, "App.xcodeproj");
    await mkdir(path);
    return path;
  }

  test("resolves a legacy PBX project document", async () => {
    const path = await project();
    await writeFile(join(path, "project.pbxproj"), "// !$*UTF8*$!\n");

    expect(await resolveXcodeProjectDocument(path)).toEqual({
      status: "found",
      document: {
        format: "pbxproj",
        fileName: "project.pbxproj",
        projectPath: path,
        absolutePath: join(path, "project.pbxproj"),
      },
    });
  });

  test("resolves an Xcode JSON project document", async () => {
    const path = await project();
    await writeFile(join(path, "project.xcproj"), '{ "files": [], }\n');

    expect(await resolveXcodeProjectDocument(path)).toEqual({
      status: "found",
      document: {
        format: "xcproj",
        fileName: "project.xcproj",
        projectPath: path,
        absolutePath: join(path, "project.xcproj"),
      },
    });
  });

  test("fails closed when both formats exist", async () => {
    const path = await project();
    await writeFile(join(path, "project.pbxproj"), "// !$*UTF8*$!\n");
    await writeFile(join(path, "project.xcproj"), "{}\n");

    expect(await resolveXcodeProjectDocument(path)).toEqual({ status: "ambiguous" });
  });

  test("does not follow a project-document symlink", async () => {
    const path = await project();
    const outside = join(path, "..", "outside.xcproj");
    await writeFile(outside, "{}\n");
    await symlink(outside, join(path, "project.xcproj"));

    expect(await resolveXcodeProjectDocument(path)).toEqual({ status: "missing" });
  });
});
