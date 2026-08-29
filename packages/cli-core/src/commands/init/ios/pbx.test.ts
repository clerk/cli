import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildPbxParentIndex,
  isClerkIOSRepository,
  resolvePbxFilePath,
  sanitizeRepositoryURL,
  type PbxObjects,
} from "./pbx.ts";

describe("resolvePbxFilePath", () => {
  test("does not treat a pathless group's display name as a directory", () => {
    const objects: PbxObjects = {
      root: {
        isa: "PBXGroup",
        children: ["logical"],
        sourceTree: "<group>",
      },
      logical: {
        isa: "PBXGroup",
        children: ["file"],
        name: "Navigator Label",
        sourceTree: "<group>",
      },
      file: {
        isa: "PBXFileReference",
        name: "Display Name.swift",
        path: "Sources/App.swift",
        sourceTree: "<group>",
      },
    };
    const projectDirectory = join("/", "tmp", "Example");

    expect(
      resolvePbxFilePath("file", objects, buildPbxParentIndex(objects), projectDirectory),
    ).toBe(join(projectDirectory, "Sources", "App.swift"));
  });

  test("does not guess a path from a pathless file reference's display name", () => {
    const objects: PbxObjects = {
      root: {
        isa: "PBXGroup",
        children: ["file"],
        sourceTree: "<group>",
      },
      file: {
        isa: "PBXFileReference",
        name: "Display Name.swift",
        sourceTree: "<group>",
      },
    };

    expect(
      resolvePbxFilePath("file", objects, buildPbxParentIndex(objects), "/tmp/Example"),
    ).toBeUndefined();
  });

  test("uses projectDirPath only for group-relative paths, not SOURCE_ROOT", () => {
    const objects: PbxObjects = {
      main: { isa: "PBXGroup", children: ["group", "sourceRootFile"], sourceTree: "<group>" },
      group: {
        isa: "PBXGroup",
        children: ["groupFile"],
        path: "Sources",
        sourceTree: "<group>",
      },
      groupFile: { isa: "PBXFileReference", path: "App.swift", sourceTree: "<group>" },
      sourceRootFile: {
        isa: "PBXFileReference",
        path: "Root.swift",
        sourceTree: "SOURCE_ROOT",
      },
    };
    const parents = buildPbxParentIndex(objects);

    expect(
      resolvePbxFilePath(
        "groupFile",
        objects,
        parents,
        "/tmp/Example",
        "/tmp/Example/ActualProjectRoot",
      ),
    ).toBe("/tmp/Example/ActualProjectRoot/Sources/App.swift");
    expect(
      resolvePbxFilePath(
        "sourceRootFile",
        objects,
        parents,
        "/tmp/Example",
        "/tmp/Example/ActualProjectRoot",
      ),
    ).toBe("/tmp/Example/Root.swift");
  });

  test("does not resolve a group-relative object with multiple distinct parents", () => {
    const file = {
      isa: "PBXFileReference",
      path: "App.swift",
      sourceTree: "<group>",
    };
    const firstGroup = {
      isa: "PBXGroup",
      children: ["file"],
      path: "First",
      sourceTree: "<group>",
    };
    const secondGroup = {
      isa: "PBXGroup",
      children: ["file"],
      path: "Second",
      sourceTree: "<group>",
    };

    for (const objects of [
      { firstGroup, secondGroup, file },
      { secondGroup, firstGroup, file },
    ] satisfies PbxObjects[]) {
      const parents = buildPbxParentIndex(objects);

      expect(parents.get("file")).toBeNull();
      expect(resolvePbxFilePath("file", objects, parents, "/tmp/Example")).toBeUndefined();
    }
  });

  test("keeps repeated membership in one parent unambiguous", () => {
    const objects: PbxObjects = {
      group: {
        isa: "PBXGroup",
        children: ["file", "file"],
        path: "Sources",
        sourceTree: "<group>",
      },
      file: { isa: "PBXFileReference", path: "App.swift", sourceTree: "<group>" },
    };
    const parents = buildPbxParentIndex(objects);

    expect(parents.get("file")).toBe("group");
    expect(resolvePbxFilePath("file", objects, parents, "/tmp/Example")).toBe(
      "/tmp/Example/Sources/App.swift",
    );
  });
});

describe("sanitizeRepositoryURL", () => {
  test("canonicalizes Clerk HTTPS and SCP-style repository URLs", () => {
    expect(sanitizeRepositoryURL("https://token@example.com/clerk/clerk-ios.git?key=secret")).toBe(
      "https://example.com/clerk/clerk-ios",
    );
    expect(sanitizeRepositoryURL("git@github.com:clerk/clerk-ios.git")).toBe(
      "ssh://github.com/clerk/clerk-ios",
    );
    expect(isClerkIOSRepository("git@github.com:clerk/clerk-ios.git")).toBe(true);
  });

  test("does not expose unsupported local or malformed repository values", () => {
    expect(sanitizeRepositoryURL("file:///Users/alice/private/clerk-ios")).toBe(
      "file://<redacted>",
    );
    expect(sanitizeRepositoryURL("not valid token@example.com/path")).toBe(
      "<invalid-repository-url>",
    );
  });
});
