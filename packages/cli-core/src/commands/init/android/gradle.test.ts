import { describe, expect, test } from "bun:test";
import {
  appendToCatalogSection,
  blocks,
  catalogValueOffsets,
  childBlock,
  insertIntoBlock,
  integerLiteral,
  literal,
  parseCatalog,
  topLevelBlocks,
  usesAccessor,
} from "./gradle.ts";

const build = `plugins { id("com.android.application") }
// namespace = "com.commented"
android {
    namespace = "com.example.app" // trailing comment
    defaultConfig {
        applicationId = "com.example.installed"
        minSdk = 23
    }
    buildTypes { debug { applicationIdSuffix = ".debug" } }
}
dependencies {
    implementation("androidx.core:core-ktx:1.18.0")
}
`;

describe("Gradle script reads", () => {
  test("reads a literal set once, ignoring comments and strings", () => {
    expect(literal(build, "namespace")).toBe("com.example.app");
    expect(literal(build, "applicationId")).toBe("com.example.installed");
    expect(literal("applicationId 'com.groovy'\n", "applicationId")).toBe("com.groovy");
    expect(literal('applicationId("com.call")\n', "applicationId")).toBe("com.call");
  });

  test("refuses computed, repeated, or interpolated values", () => {
    expect(literal('applicationId = "a" + suffix\n', "applicationId")).toBeUndefined();
    expect(literal('applicationId = "a"\napplicationId = "b"\n', "applicationId")).toBeUndefined();
    expect(literal('applicationId = "${base}.app"\n', "applicationId")).toBeUndefined();
    expect(
      literal('applicationId = providers.gradleProperty("x").get()\n', "applicationId"),
    ).toBeUndefined();
  });

  test("reads integer literals", () => {
    expect(integerLiteral("minSdk = 23\n", "minSdk")).toBe(23);
    expect(integerLiteral("minSdk 23\n", "minSdk")).toBe(23);
    expect(integerLiteral("minSdk = libs.versions.min.get()\n", "minSdk")).toBeUndefined();
  });

  test("finds blocks by nesting", () => {
    expect(blocks(build, "android")).toHaveLength(1);
    const [android] = topLevelBlocks(build, "android");
    expect(childBlock(build, android!, "defaultConfig")).toBeDefined();
    const buildTypes = childBlock(build, android!, "buildTypes")!;
    expect(childBlock(build, buildTypes, "debug")).toBeDefined();
    expect(topLevelBlocks(build, "debug")).toHaveLength(0);
    expect(() => blocks("android {", "android")).toThrow("Unbalanced");
  });

  test("inserts into a block with its indentation", () => {
    const [dependencies] = topLevelBlocks(build, "dependencies");
    const next = insertIntoBlock(build, dependencies!, ['implementation("a:b:1")']);
    expect(next).toContain(
      'dependencies {\n    implementation("a:b:1")\n    implementation("androidx',
    );
  });
});

describe("version catalogs", () => {
  const catalog = `[versions]
agp = "9.2.1"
kotlin = "2.3.21"

[libraries]
core = { group = "androidx.core", name = "core-ktx", version = "1.18.0" }
clerk-ui = { module = "com.clerk:clerk-android-ui", version.ref = "clerk" }
plain = "com.example:plain:1.0"

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
`;

  test("parses the entries setup reads", () => {
    const parsed = parseCatalog(catalog);
    expect(parsed.versions.kotlin).toBe("2.3.21");
    expect(parsed.libraries.core).toEqual({
      module: "androidx.core:core-ktx",
      version: "1.18.0",
      versionRef: undefined,
    });
    expect(parsed.libraries["clerk-ui"]).toMatchObject({
      module: "com.clerk:clerk-android-ui",
      versionRef: "clerk",
    });
    expect(parsed.libraries.plain).toEqual({ module: "com.example:plain", version: "1.0" });
    expect(parsed.plugins["android-application"]).toMatchObject({
      id: "com.android.application",
      versionRef: "agp",
    });
    expect(() => parseCatalog("[versions\n")).toThrow("could not be parsed");
  });

  test("appends to a table before the next one, or creates it", () => {
    const next = appendToCatalogSection(catalog, "versions", 'clerk = "1.3.0"');
    expect(next).toContain('kotlin = "2.3.21"\nclerk = "1.3.0"\n\n[libraries]');
    const created = appendToCatalogSection('[versions]\nx = "1"\n', "libraries", 'a = "b:c:1"');
    expect(created).toBe('[versions]\nx = "1"\n\n[libraries]\na = "b:c:1"\n');
    expect(appendToCatalogSection("", "versions", 'x = "1"')).toBe('[versions]\nx = "1"\n');
  });

  test("finds a [versions] value by offset, matching the key as text", () => {
    const source =
      '[versions]\nminSdk-legacy = "21"\nminSdk = "23" # shared\nminSdk.other = "23"\n';
    const found = catalogValueOffsets(source, "minSdk", "23")!;
    expect(source.slice(found.start, found.end)).toBe("23");
    expect(source.slice(0, found.start)).toEndWith('minSdk = "');
    expect(catalogValueOffsets(source, "minSdk", "24")).toBeUndefined();
    expect(catalogValueOffsets(source, "min.*", "23")).toBeUndefined();
    expect(catalogValueOffsets('minSdk = { strictly = "23" }\n', "minSdk", "23")).toBeUndefined();
  });

  test("matches generated accessors outside comments", () => {
    expect(usesAccessor("implementation(libs.clerk.ui)", "libs.clerk.ui")).toBe(true);
    expect(usesAccessor("implementation(libs.clerk.ui.extra)", "libs.clerk.ui")).toBe(false);
    expect(usesAccessor("// implementation(libs.clerk.ui)", "libs.clerk.ui")).toBe(false);
  });
});
