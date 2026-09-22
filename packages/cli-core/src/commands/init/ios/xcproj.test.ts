import { describe, expect, test } from "bun:test";
import {
  applyXCProjValue,
  parseXCProjSource,
  XCProjError,
  xcprojArray,
  xcprojBuildPhases,
  xcprojPackages,
  xcprojRecord,
  xcprojString,
  xcprojStringArray,
  xcprojTargets,
} from "./xcproj.ts";

const XCODE_GENERATED_PROJECT = `{
  // Xcode project metadata remains untouched by surgical edits.
  "default-configuration": "Release",
  "configurations": [
    "Debug",
    { "name": "Release", "file": { "anchor": "App", "relative-path": "Config.xcconfig" } },
  ],
  "localizations": {
    "development": "en",
    "supported": [
      "Base",
    ],
  },
  "packages": [
    {
      "kind": "remote",
      "repository": "https://github.com/clerk/clerk-ios",
      "version": {
        "up-to-next-major-version": "1.0.0",
      },
    },
    { "kind": "local", "path": "LocalPackage" },
  ],
  "files": [
    { "kind": "folder", "path": "App", "target-membership": [ "App" ] },
  ],
  "targets": [
    {
      "name": "App",
      "id": "000000000000000100000000",
      "product-type": "application",
      "build-phases": [
        "compile-sources",
        "frameworks",
        { "kind": "script", "name": "Generate", "shell": "/bin/sh", "script": "true" },
      ],
      "package-product-members": [
        {
          "package": "clerk-ios",
          "product-name": "ClerkKit",
          "build-phase": { "build-phase": "frameworks" },
        },
      ],
      "build-settings": {
        "PRODUCT_BUNDLE_IDENTIFIER": "com.example.App",
        "SUPPORTED_PLATFORMS": [ "iphoneos", "iphonesimulator" ],
      },
    },
  ],
  "build-settings": {
    "SDKROOT": "iphoneos",
  },
}
`;

describe("parseXCProjSource", () => {
  test("parses the canonical Xcode JSON shape with comments and trailing commas", () => {
    const parsed = parseXCProjSource(XCODE_GENERATED_PROJECT);

    expect(parsed.source).toBe(XCODE_GENERATED_PROJECT);
    expect(parsed.root["default-configuration"]).toBe("Release");
    expect(xcprojTargets(parsed.root)).toEqual([
      expect.objectContaining({
        name: "App",
        id: "000000000000000100000000",
        kind: "native",
        productType: "application",
        buildSettings: {
          PRODUCT_BUNDLE_IDENTIFIER: "com.example.App",
          SUPPORTED_PLATFORMS: ["iphoneos", "iphonesimulator"],
        },
      }),
    ]);
    expect(xcprojBuildPhases(xcprojTargets(parsed.root)[0]!.raw)).toEqual([
      { kind: "compile-sources", raw: "compile-sources" },
      { kind: "frameworks", raw: "frameworks" },
      expect.objectContaining({ kind: "script", name: "Generate" }),
    ]);
    expect(xcprojPackages(parsed.root)).toEqual([
      expect.objectContaining({
        kind: "remote",
        repository: "https://github.com/clerk/clerk-ios",
        version: { "up-to-next-major-version": "1.0.0" },
        traits: [],
      }),
      expect.objectContaining({ kind: "local", path: "LocalPackage", traits: [] }),
    ]);
  });

  test("accepts bounded UTF-8 bytes", () => {
    const bytes = new TextEncoder().encode(XCODE_GENERATED_PROJECT);
    expect(parseXCProjSource(bytes).root["default-configuration"]).toBe("Release");
  });

  test("accepts component-array configuration file references", () => {
    const source = XCODE_GENERATED_PROJECT.replace(
      '{ "anchor": "App", "relative-path": "Config.xcconfig" }',
      '[ { "name": "Build/Settings" }, "Base.xcconfig" ]',
    );

    expect(parseXCProjSource(source).root.configurations).toEqual([
      "Debug",
      {
        name: "Release",
        file: [{ name: "Build/Settings" }, "Base.xcconfig"],
      },
    ]);
  });

  test("accepts component-array target build-phase references", () => {
    const source = XCODE_GENERATED_PROJECT.replace(
      '"build-phase": { "build-phase": "frameworks" }',
      '"build-phase": { "build-phase": [ "frameworks", { "name": "App/Dependencies" } ] }',
    );

    expect(xcprojTargets(parseXCProjSource(source).root)[0]?.packageProductMembers[0]).toEqual(
      expect.objectContaining({
        "build-phase": { "build-phase": ["frameworks", { name: "App/Dependencies" }] },
      }),
    );
  });

  test("accepts and preserves a null Products group reference", () => {
    const source = XCODE_GENERATED_PROJECT.replace(
      '  "localizations": {',
      '  "products-group": null,\n  "localizations": {',
    );

    const parsed = parseXCProjSource(source);
    expect(parsed.root["products-group"]).toBeNull();
    expect(xcprojTargets(parsed.root)).toHaveLength(1);

    const edited = applyXCProjValue(source, ["organization"], "Example");
    expect(parseXCProjSource(edited).root["products-group"]).toBeNull();
  });

  test("rejects malformed component-array configuration file references", () => {
    const source = XCODE_GENERATED_PROJECT.replace(
      '{ "anchor": "App", "relative-path": "Config.xcconfig" }',
      '[ { "wrong": "Build/Settings" }, "Base.xcconfig" ]',
    );

    expect(() => parseXCProjSource(source)).toThrow(
      expect.objectContaining({ code: "invalid-schema" }),
    );
  });

  test("rejects input before decoding when it exceeds the byte bound", () => {
    expect(() => parseXCProjSource(XCODE_GENERATED_PROJECT, { maxBytes: 16 })).toThrow(
      expect.objectContaining({ code: "too-large" }),
    );
  });

  test("rejects invalid UTF-8", () => {
    expect(() => parseXCProjSource(Uint8Array.from([0xff]))).toThrow(
      expect.objectContaining({ code: "invalid-utf8" }),
    );
  });

  test("rejects duplicate keys instead of accepting parser last-write behavior", () => {
    const source = XCODE_GENERATED_PROJECT.replace(
      '"default-configuration": "Release",',
      '"default-configuration": "Debug",\n  "default-configuration": "Release",',
    );
    expect(() => parseXCProjSource(source)).toThrow(
      expect.objectContaining({ code: "duplicate-key" }),
    );
  });

  test("fails closed on required capabilities", () => {
    const source = XCODE_GENERATED_PROJECT.replace(
      "{\n",
      '{\n  "required-capabilities": [ "future-xcode-feature" ],\n',
    );
    expect(() => parseXCProjSource(source)).toThrow(
      expect.objectContaining({ code: "unsupported-capability" }),
    );
  });

  test("rejects malformed compact build phases", () => {
    const source = XCODE_GENERATED_PROJECT.replace('"compile-sources",', '"script",');
    expect(() => parseXCProjSource(source)).toThrow(
      expect.objectContaining({ code: "invalid-schema" }),
    );
  });

  test("rejects malformed string arrays without silently filtering entries", () => {
    const source = XCODE_GENERATED_PROJECT.replace(
      '[ "iphoneos", "iphonesimulator" ]',
      '[ "iphoneos", false ]',
    );
    expect(() => parseXCProjSource(source)).toThrow(
      expect.objectContaining({ code: "invalid-schema" }),
    );
  });

  test("never echoes project contents in parse errors", () => {
    const source = XCODE_GENERATED_PROJECT.replace(
      '"SDKROOT": "iphoneos",',
      '"SDKROOT": "super-secret-value", BROKEN',
    );
    try {
      parseXCProjSource(source);
      throw new Error("expected parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(XCProjError);
      expect((error as Error).message).not.toContain("super-secret-value");
      expect((error as XCProjError).code).toBe("invalid-syntax");
    }
  });
});

describe("strict Xcode JSON value helpers", () => {
  test("return only exact requested shapes", () => {
    expect(xcprojRecord({ key: "value" })).toEqual({ key: "value" });
    expect(xcprojArray(["value"])).toEqual(["value"]);
    expect(xcprojString("value")).toBe("value");
    expect(xcprojStringArray(["one", "two"])).toEqual(["one", "two"]);
  });

  test("do not coerce scalars or partially valid arrays", () => {
    expect(() => xcprojRecord([])).toThrow(XCProjError);
    expect(() => xcprojArray({ 0: "value" })).toThrow(XCProjError);
    expect(() => xcprojString(1)).toThrow(XCProjError);
    expect(() => xcprojStringArray(["one", 2])).toThrow(XCProjError);
  });
});

describe("applyXCProjValue", () => {
  test("replaces one value without reserializing comments or unrelated bytes", () => {
    const candidate = applyXCProjValue(
      XCODE_GENERATED_PROJECT,
      ["targets", 0, "build-settings", "PRODUCT_BUNDLE_IDENTIFIER"],
      "com.example.Updated",
    );

    expect(candidate).toBe(
      XCODE_GENERATED_PROJECT.replace("com.example.App", "com.example.Updated"),
    );
    expect(candidate).toContain("// Xcode project metadata remains untouched");
  });

  test("inserts a setting while preserving existing comments", () => {
    const candidate = applyXCProjValue(
      XCODE_GENERATED_PROJECT,
      ["targets", 0, "build-settings", "CODE_SIGN_ENTITLEMENTS"],
      "App/App.entitlements",
    );

    expect(candidate).toContain('"CODE_SIGN_ENTITLEMENTS": "App/App.entitlements"');
    expect(candidate).toContain("// Xcode project metadata remains untouched");
    expect(parseXCProjSource(candidate).root.targets).toBeArray();
  });

  test("refuses an edit that violates required root schema", () => {
    expect(() =>
      applyXCProjValue(XCODE_GENERATED_PROJECT, ["default-configuration"], undefined),
    ).toThrow(expect.objectContaining({ code: "invalid-schema" }));
  });
});
