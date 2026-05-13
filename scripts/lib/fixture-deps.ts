import semver from "semver";

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type DependencyField = "dependencies" | "devDependencies";

export type DependencyVersionResolver = (name: string, spec: string) => string | Promise<string>;

export type PackageJsonOverrides = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const DEPENDENCY_FIELDS: DependencyField[] = ["dependencies", "devDependencies"];
const EXACT_VERSION_EXCLUDED_PACKAGE_SCOPES = ["@clerk/"];

export function applyPackageJsonOverrides(
  pkg: PackageJson,
  overrides: PackageJsonOverrides | undefined,
): void {
  if (!overrides) return;

  if (overrides.dependencies) {
    pkg.dependencies = { ...pkg.dependencies, ...overrides.dependencies };
  }

  if (overrides.devDependencies) {
    pkg.devDependencies = { ...pkg.devDependencies, ...overrides.devDependencies };
  }
}

export async function resolveDependencySpecsToExactVersions(
  pkg: PackageJson,
  resolveVersion: DependencyVersionResolver,
): Promise<void> {
  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field];
    if (!deps) continue;

    for (const [name, spec] of Object.entries(deps)) {
      if (EXACT_VERSION_EXCLUDED_PACKAGE_SCOPES.some((scope) => name.startsWith(scope))) {
        continue;
      }

      const exact = semver.valid(spec);
      if (exact) {
        deps[name] = exact;
        continue;
      }

      const resolved = await resolveVersion(name, spec);
      const resolvedExact = semver.valid(resolved);
      if (!resolvedExact) {
        throw new Error(`${name}@${spec} resolved to non-exact version "${resolved}"`);
      }

      deps[name] = resolvedExact;
    }
  }
}

function isSpecWithinRange(spec: string, range: string): boolean {
  if (!semver.validRange(range)) return false;

  const exact = semver.valid(spec);
  if (exact) return semver.satisfies(exact, range);

  const specRange = semver.validRange(spec);
  return Boolean(specRange && semver.subset(specRange, range));
}

export function validatePinnedDependencyRanges(
  pkg: PackageJson,
  pinnedDependencyRanges: Record<string, string> | undefined,
): string[] {
  if (!pinnedDependencyRanges) return [];

  const warnings: string[] = [];

  for (const [dep, range] of Object.entries(pinnedDependencyRanges)) {
    const deps = pkg.dependencies;
    const devDeps = pkg.devDependencies;
    const target = deps?.[dep] !== undefined ? deps : devDeps?.[dep] !== undefined ? devDeps : null;

    if (!target) {
      warnings.push(`${dep} was not generated, so pinned range "${range}" was not applied`);
      continue;
    }

    const generatedSpec = target[dep]!;
    if (!isSpecWithinRange(generatedSpec, range)) {
      warnings.push(
        `${dep} generated version "${generatedSpec}" does not satisfy pinned range "${range}"`,
      );
      continue;
    }
  }

  return warnings;
}

export function assertPinnedDependencyRanges(
  pkg: PackageJson,
  pinnedDependencyRanges: Record<string, string> | undefined,
  fixtureName: string,
): void {
  const errors = validatePinnedDependencyRanges(pkg, pinnedDependencyRanges);
  if (errors.length === 0) return;

  throw new Error(
    [
      `Pinned dependency validation failed for ${fixtureName}:`,
      ...errors.map((error) => `  - ${error}`),
    ].join("\n"),
  );
}
