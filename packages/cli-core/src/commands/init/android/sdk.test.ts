import { describe, expect, test } from "bun:test";
import { parseCatalog } from "./gradle.ts";
import {
  findClerkDependencies,
  kotlinHealth,
  planSdkDependencies,
  sdkHealth,
  sdkInstalled,
} from "./sdk.ts";

const build = `dependencies {\n    implementation("androidx.core:core-ktx:1.18.0")\n}\n`;

describe("SDK dependencies", () => {
  test("finds literal and catalog dependencies, not commented ones", () => {
    const catalog = parseCatalog(
      '[libraries]\nclerk-ui = { module = "com.clerk:clerk-android-ui", version = "1.2.0" }\n',
    );
    expect(
      findClerkDependencies(
        'dependencies {\n    implementation("com.clerk:clerk-android-api:1.3.0")\n    // implementation("com.clerk:clerk-android-ui:0.1.0")\n}',
        undefined,
      ),
    ).toEqual([{ product: "core", version: "1.3.0", via: "literal" }]);
    expect(
      findClerkDependencies("dependencies { implementation(libs.clerk.ui) }", catalog),
    ).toEqual([{ product: "ui", version: "1.2.0", via: "catalog", alias: "clerk-ui" }]);
    expect(findClerkDependencies("dependencies { }", catalog)).toEqual([]);
    expect(sdkInstalled([{ product: "ui", via: "literal" }], "core")).toBe(true);
    expect(sdkInstalled([{ product: "core", via: "literal" }], "ui")).toBe(false);
  });

  test("adds a literal dependency without a catalog", () => {
    const plan = planSdkDependencies({
      build,
      sdk: "core",
      minimumVersion: "1.3.0",
      dependencies: [],
    });
    expect(plan.build).toContain(
      'dependencies {\n    implementation("com.clerk:clerk-android-api:1.3.0")\n    implementation("androidx',
    );
    expect(plan.added).toEqual(["com.clerk:clerk-android-api:1.3.0"]);
    expect(plan.catalog).toBeUndefined();
  });

  test("adds a dependencies block when the script has none", () => {
    const plan = planSdkDependencies({
      build: "android {}\n",
      sdk: "core",
      minimumVersion: "1.3.0",
      dependencies: [],
    });
    expect(plan.build).toBe(
      'android {}\n\ndependencies {\n    implementation("com.clerk:clerk-android-api:1.3.0")\n}\n',
    );
  });

  test("adds the UI artifact and lifecycle-viewmodel-compose through the catalog", () => {
    const catalogSource =
      '[versions]\nagp = "9.2.1"\n\n[libraries]\ncore = "androidx.core:core-ktx:1.18.0"\n\n[plugins]\nandroid-application = { id = "com.android.application", version.ref = "agp" }\n';
    const plan = planSdkDependencies({
      build,
      catalogSource,
      sdk: "ui",
      minimumVersion: "1.3.0",
      dependencies: [],
    });
    expect(plan.catalog).toContain(
      'agp = "9.2.1"\nclerk = "1.3.0"\nlifecycleViewmodelCompose = "2.10.0"\n\n[libraries]',
    );
    expect(plan.catalog).toContain(
      'clerk-android-ui = { module = "com.clerk:clerk-android-ui", version.ref = "clerk" }',
    );
    expect(plan.catalog).toContain(
      'androidx-lifecycle-viewmodel-compose = { module = "androidx.lifecycle:lifecycle-viewmodel-compose", version.ref = "lifecycleViewmodelCompose" }',
    );
    expect(plan.build).toContain(
      "implementation(libs.clerk.android.ui)\n    implementation(libs.androidx.lifecycle.viewmodel.compose)",
    );
    expect(plan.added).toEqual([
      "com.clerk:clerk-android-ui:1.3.0",
      "androidx.lifecycle:lifecycle-viewmodel-compose:2.10.0",
    ]);
  });

  test("reuses an existing catalog entry for the same module", () => {
    const catalogSource =
      '[libraries]\nauth = { module = "com.clerk:clerk-android-api", version = "1.3.0" }\n';
    const plan = planSdkDependencies({
      build,
      catalogSource,
      sdk: "core",
      minimumVersion: "1.3.0",
      dependencies: [],
    });
    expect(plan.catalog).toBe(catalogSource);
    expect(plan.build).toContain("implementation(libs.auth)");
  });

  test("refuses a catalog that already uses the alias for something else", () => {
    const catalogSource = '[versions]\nclerk = "9"\n[libraries]\nother = "a:b:1"\n';
    expect(() =>
      planSdkDependencies({
        build,
        catalogSource,
        sdk: "core",
        minimumVersion: "1.3.0",
        dependencies: [],
      }),
    ).toThrow("already defines");
  });

  test("leaves an installed SDK alone", () => {
    const plan = planSdkDependencies({
      build,
      sdk: "core",
      minimumVersion: "1.3.0",
      dependencies: [{ product: "ui", via: "literal", version: "1.3.0" }],
    });
    expect(plan.build).toBe(build);
    expect(plan.added).toEqual([]);
  });

  test("refuses more than one top-level dependencies block", () => {
    expect(() =>
      planSdkDependencies({
        build: "dependencies {}\ndependencies {}\n",
        sdk: "core",
        minimumVersion: "1.3.0",
        dependencies: [],
      }),
    ).toThrow("more than one");
  });
});

describe("health checks", () => {
  test("SDK version", () => {
    expect(sdkHealth([], "1.3.0").status).toBe("warn");
    expect(sdkHealth([{ product: "core", via: "literal", version: "1.3.0" }], "1.3.0").status).toBe(
      "pass",
    );
    expect(
      sdkHealth([{ product: "core", via: "literal", version: "1.1.7" }], "1.3.0"),
    ).toMatchObject({ status: "fail", remedy: expect.stringContaining("1.3.0") });
    expect(sdkHealth([{ product: "core", via: "catalog" }], "1.3.0").status).toBe("warn");
  });

  test("Kotlin compiler", () => {
    expect(
      kotlinHealth({ version: "2.3.21", source: "catalog", applied: "yes" }, "2.3.0").status,
    ).toBe("pass");
    expect(
      kotlinHealth({ version: "2.2.21", source: "catalog", applied: "yes" }, "2.3.0"),
    ).toMatchObject({ status: "fail", message: expect.stringContaining("2.4 metadata") });
    expect(
      kotlinHealth({ source: "AGP 9.2.1's built-in Kotlin", applied: "yes" }, "2.3.0").status,
    ).toBe("warn");
    expect(
      kotlinHealth(
        { version: "2.2.10", source: "AGP 9.2.1's built-in Kotlin", applied: "yes" },
        "2.3.0",
      ),
    ).toMatchObject({ status: "fail", remedy: expect.stringContaining("kotlin.plugin.compose") });
    expect(kotlinHealth({ source: "not declared", applied: "no" }, "2.3.0").status).toBe("fail");
    expect(
      kotlinHealth(
        {
          source: "not declared where clerk init reads it; a convention plugin may set it",
          applied: "unknown",
        },
        "2.3.0",
      ),
    ).toMatchObject({ status: "warn", remedy: expect.stringContaining("convention plugins") });
    expect(
      kotlinHealth(
        { version: "2.3.21", source: "settings.gradle.kts", applied: "unknown" },
        "2.3.0",
      ).status,
    ).toBe("pass");
  });
});
