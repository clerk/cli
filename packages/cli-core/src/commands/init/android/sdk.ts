import semver from "semver";
import {
  catalogAccessor,
  catalogVersion,
  insertIntoBlock,
  literalDependencies,
  parseCatalog,
  topLevelBlocks,
  usesAccessor,
  appendToCatalogSection,
  type Catalog,
} from "./gradle.ts";
import { unsupported, type AndroidSdk } from "./types.ts";

/**
 * Tested recipe baseline. Gradle resolves exactly this version unless the project pins another,
 * so it is raised deliberately, with the Kotlin baseline below.
 */
export const CLERK_ANDROID_MINIMUM_VERSION = "1.3.0";
/**
 * The SDK is compiled with Kotlin 2.4, and a Kotlin compiler reads metadata up to one minor
 * version ahead of itself, so 2.3 is the oldest compiler that can consume it (verified against
 * 1.3.0: 2.3.21 compiles, 2.2.21 fails with an incompatible metadata version).
 */
export const CLERK_ANDROID_KOTLIN_MINIMUM = "2.3.0";
/** The SDK's own floor. */
export const CLERK_ANDROID_MIN_SDK = 24;
/** The lifecycle release the UI artifact depends on; the quickstart adds it beside the SDK. */
const LIFECYCLE_VIEWMODEL_COMPOSE_VERSION = "2.10.0";

export const ARTIFACTS = {
  core: "com.clerk:clerk-android-api",
  ui: "com.clerk:clerk-android-ui",
} as const;
const LIFECYCLE_VIEWMODEL_COMPOSE = "androidx.lifecycle:lifecycle-viewmodel-compose";
export const ALREADY_INSTALLED =
  "The requested Clerk SDK dependency is already declared; its compatibility is not verified.";

export interface ClerkDependency {
  product: AndroidSdk;
  /** The declared or catalog-resolved version, when it is a plain literal. */
  version?: string;
  via: "literal" | "catalog";
  alias?: string;
}

export interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  /** How to resolve a non-passing check, when it isn't something `clerk init` completes. */
  remedy?: string;
}

function productOf(coordinate: string): AndroidSdk | undefined {
  const module = coordinate.split(":").slice(0, 2).join(":");
  return module === ARTIFACTS.core ? "core" : module === ARTIFACTS.ui ? "ui" : undefined;
}

/** Every Clerk SDK dependency the module declares, directly or through the version catalog. */
export function findClerkDependencies(build: string, catalog?: Catalog): ClerkDependency[] {
  const found: ClerkDependency[] = [];
  for (const { coordinate } of literalDependencies(build)) {
    const product = productOf(coordinate);
    if (!product) continue;
    const version = coordinate.split(":")[2];
    found.push({ product, version, via: "literal" });
  }
  if (catalog)
    for (const [alias, library] of Object.entries(catalog.libraries)) {
      const product = library.module ? productOf(library.module) : undefined;
      if (!product || !usesAccessor(build, catalogAccessor(alias))) continue;
      found.push({ product, version: catalogVersion(catalog, library), via: "catalog", alias });
    }
  return found;
}

/** Whether the requested products are installed, or will be once this plan applies. */
export function sdkInstalled(dependencies: ClerkDependency[], sdk: AndroidSdk): boolean {
  // The UI artifact depends on the API artifact, so it satisfies a core request too.
  return dependencies.some((item) => item.product === sdk || item.product === "ui");
}

export function sdkHealth(dependencies: ClerkDependency[], minimumVersion: string): Check {
  const name = "SDK version requirement";
  if (!dependencies.length)
    return {
      name,
      status: "warn",
      message: `No Clerk SDK dependency is declared; setup adds ${minimumVersion}.`,
      remedy: "Run clerk init to add the dependency.",
    };
  const versions = dependencies.map((item) => item.version);
  const unknown = versions.filter((version) => !version || !semver.valid(version));
  if (unknown.length)
    return {
      name,
      status: "warn",
      message: `The Clerk SDK version could not be read from the build script; ${minimumVersion} or newer is required. Compilation remains unverified.`,
      remedy: `Declare a plain version of ${minimumVersion} or newer.`,
    };
  const lowest = versions.filter((v): v is string => !!v).sort(semver.compare)[0]!;
  const compatible = semver.gte(lowest, minimumVersion);
  return {
    name,
    status: compatible ? "pass" : "fail",
    message: compatible
      ? `Clerk ${lowest} is declared; it meets the ${minimumVersion} baseline. Compilation remains unverified.`
      : `Clerk ${lowest} is declared, below the ${minimumVersion} baseline.`,
    remedy: compatible
      ? undefined
      : `Update the Clerk dependency to ${minimumVersion} or newer in the build script or version catalog.`,
  };
}

/**
 * The Kotlin compiler the module uses, when the build declares it in one of the ordinary
 * places: the catalog's `kotlin` version used by a Kotlin plugin alias, a literal Kotlin plugin
 * version, or the Kotlin Gradle plugin on a buildscript classpath.
 */
export function kotlinHealth(
  kotlin: { version?: string; source: string; applied: "yes" | "no" | "unknown" },
  minimum: string,
): Check {
  const name = "Kotlin compiler";
  if (kotlin.applied === "no")
    return {
      name,
      status: "fail",
      message:
        "The module compiles no Kotlin: it applies neither the Kotlin Android plugin nor AGP 9's built-in Kotlin.",
      remedy: "Apply org.jetbrains.kotlin.android, or update to AGP 9, then rerun clerk init.",
    };
  if (kotlin.applied === "unknown" && !kotlin.version)
    return {
      name,
      status: "warn",
      message: `The Kotlin toolchain is ${kotlin.source}; the Clerk SDK needs Kotlin ${semver.major(minimum)}.${semver.minor(minimum)} or newer.`,
      remedy: `Check the Kotlin version your convention plugins apply; ${semver.major(minimum)}.${semver.minor(minimum)}+ is required.`,
    };
  if (!kotlin.version)
    return {
      name,
      status: "warn",
      message: `The Kotlin version could not be read from the build (${kotlin.source}); the Clerk SDK needs Kotlin ${semver.major(minimum)}.${semver.minor(minimum)} or newer.`,
      remedy: `Check the Kotlin Gradle plugin version your build resolves; ${semver.major(minimum)}.${semver.minor(minimum)}+ is required.`,
    };
  const version = semver.coerce(kotlin.version);
  const compatible = version != null && semver.gte(version, minimum);
  return {
    name,
    status: compatible ? "pass" : "fail",
    message: compatible
      ? `Kotlin ${kotlin.version} (${kotlin.source}) meets the ${semver.major(minimum)}.${semver.minor(minimum)} baseline.`
      : `Kotlin ${kotlin.version} (${kotlin.source}) is older than ${semver.major(minimum)}.${semver.minor(minimum)}, which the Clerk SDK needs: its classes carry Kotlin ${semver.major(minimum)}.${semver.minor(minimum) + 1} metadata.`,
    remedy: compatible
      ? undefined
      : kotlin.source.includes("built-in")
        ? `Put a Kotlin Gradle plugin of ${semver.major(minimum)}.${semver.minor(minimum)} or newer on the build classpath, which AGP's built-in Kotlin then uses: for example alias org.jetbrains.kotlin.plugin.compose with kotlin = "2.3.21" in gradle/libs.versions.toml, then rerun clerk init.`
        : `Update Kotlin to ${semver.major(minimum)}.${semver.minor(minimum)} or newer (the \`kotlin\` entry in gradle/libs.versions.toml, or the Kotlin plugin version), then rerun clerk init.`,
  };
}

export interface SdkPlan {
  build: string;
  catalog?: string;
  /** What the plan adds, for the preview. */
  added: string[];
}

/**
 * Adds the requested SDK dependency to the module's `dependencies` block, through the version
 * catalog when the project has one. With the UI artifact, the quickstart's
 * `lifecycle-viewmodel-compose` dependency is added too.
 */
export function planSdkDependencies(
  input: {
    build: string;
    catalogSource?: string;
    sdk: AndroidSdk;
    minimumVersion: string;
    dependencies: ClerkDependency[];
  },
  // Catalog aliases are chosen here so a project can rename them later without a conflict.
  aliases = { clerk: "clerk-android", lifecycle: "androidx-lifecycle-viewmodel-compose" },
): SdkPlan {
  let { build } = input;
  let catalogSource = input.catalogSource;
  const added: string[] = [];
  const needed: { coordinate: string; version: string; alias: string; versionKey: string }[] = [];
  if (!sdkInstalled(input.dependencies, input.sdk))
    needed.push({
      coordinate: ARTIFACTS[input.sdk],
      version: input.minimumVersion,
      alias: `${aliases.clerk}-${input.sdk === "ui" ? "ui" : "api"}`,
      versionKey: "clerk",
    });
  const catalog = catalogSource ? parseCatalog(catalogSource) : undefined;
  if (
    input.sdk === "ui" &&
    !literalDependencies(build).some((item) =>
      item.coordinate.startsWith(`${LIFECYCLE_VIEWMODEL_COMPOSE}:`),
    ) &&
    !Object.entries(catalog?.libraries ?? {}).some(
      ([alias, library]) =>
        library.module === LIFECYCLE_VIEWMODEL_COMPOSE &&
        usesAccessor(build, catalogAccessor(alias)),
    )
  )
    needed.push({
      coordinate: LIFECYCLE_VIEWMODEL_COMPOSE,
      version: LIFECYCLE_VIEWMODEL_COMPOSE_VERSION,
      alias: aliases.lifecycle,
      versionKey: "lifecycleViewmodelCompose",
    });
  if (!needed.length) return { build, catalog: catalogSource, added };
  const lines: string[] = [];
  for (const item of needed) {
    if (catalog && catalogSource !== undefined) {
      // Reuse an existing catalog entry for the same module; otherwise add one.
      const existing = Object.entries(catalog.libraries).find(
        ([, library]) => library.module === item.coordinate,
      );
      let alias = existing?.[0];
      if (!alias) {
        if (catalog.libraries[item.alias] || catalog.versions[item.versionKey])
          throw unsupported(
            `gradle/libs.versions.toml already defines "${item.alias}" or a "${item.versionKey}" version for another module.`,
          );
        catalogSource = appendToCatalogSection(
          catalogSource,
          "versions",
          `${item.versionKey} = "${item.version}"`,
        );
        catalogSource = appendToCatalogSection(
          catalogSource,
          "libraries",
          `${item.alias} = { module = "${item.coordinate}", version.ref = "${item.versionKey}" }`,
        );
        alias = item.alias;
      }
      lines.push(`implementation(${catalogAccessor(alias)})`);
    } else lines.push(`implementation("${item.coordinate}:${item.version}")`);
    added.push(`${item.coordinate}:${existing(catalog, item.coordinate) ?? item.version}`);
  }
  const dependencies = topLevelBlocks(build, "dependencies");
  if (dependencies.length > 1)
    throw unsupported("The build script has more than one top-level dependencies block.");
  build = dependencies[0]
    ? insertIntoBlock(build, dependencies[0], lines)
    : `${build.replace(/\s*$/, "")}\n\ndependencies {\n${lines.map((line) => `    ${line}`).join("\n")}\n}\n`;
  return { build, catalog: catalogSource, added };
}

function existing(catalog: Catalog | undefined, coordinate: string): string | undefined {
  if (!catalog) return undefined;
  const library = Object.values(catalog.libraries).find((item) => item.module === coordinate);
  return library ? catalogVersion(catalog, library) : undefined;
}
