import { describe, expect, test } from "bun:test";
import {
  applyPackageJsonOverrides,
  assertPinnedDependencyRanges,
  resolveDependencySpecsToExactVersions,
  validatePinnedDependencyRanges,
} from "./fixture-deps.ts";

describe("applyPackageJsonOverrides", () => {
  test("merges dependency overrides into package.json", () => {
    const pkg: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    } = {
      dependencies: {
        existing: "^1",
      },
    };

    applyPackageJsonOverrides(pkg, {
      dependencies: {
        added: "^2",
      },
      devDependencies: {
        dev: "^3",
      },
    });

    expect(pkg.dependencies).toEqual({
      existing: "^1",
      added: "^2",
    });
    expect(pkg.devDependencies).toEqual({
      dev: "^3",
    });
  });
});

describe("validatePinnedDependencyRanges", () => {
  test("allows satisfying generated dependencies without changing package.json", () => {
    const pkg = {
      dependencies: {
        "fixture-framework": "1.2.3",
        react: "^18",
      },
    };

    const warnings = validatePinnedDependencyRanges(pkg, { "fixture-framework": "^1" });

    expect(warnings).toEqual([]);
    expect(pkg.dependencies["fixture-framework"]).toBe("1.2.3");
  });

  test("warns and keeps generated dependency when it falls outside the configured range", () => {
    const pkg = {
      dependencies: {
        "fixture-framework": "2.0.0",
      },
    };

    const warnings = validatePinnedDependencyRanges(pkg, { "fixture-framework": "^1" });

    expect(pkg.dependencies["fixture-framework"]).toBe("2.0.0");
    expect(warnings).toEqual([
      'fixture-framework generated version "2.0.0" does not satisfy pinned range "^1"',
    ]);
  });
});

describe("assertPinnedDependencyRanges", () => {
  test("throws when pinned dependency validation fails", () => {
    const pkg = {
      dependencies: {
        "fixture-framework": "2.0.0",
      },
    };

    expect(() =>
      assertPinnedDependencyRanges(pkg, { "fixture-framework": "^1" }, "fixture-name"),
    ).toThrow(
      'Pinned dependency validation failed for fixture-name:\n  - fixture-framework generated version "2.0.0" does not satisfy pinned range "^1"',
    );
  });
});

describe("resolveDependencySpecsToExactVersions", () => {
  test("rewrites generated dependency ranges to exact versions", async () => {
    const pkg = {
      dependencies: {
        "@clerk/react": "latest",
        react: "^19.0.0",
        "already-exact": "1.2.3",
      },
      devDependencies: {
        typescript: "~5.9.0",
      },
    };
    const resolved: string[] = [];
    const versions: Record<string, string> = {
      "react@^19.0.0": "19.2.6",
      "typescript@~5.9.0": "5.9.3",
    };

    await resolveDependencySpecsToExactVersions(pkg, async (name, spec) => {
      resolved.push(`${name}@${spec}`);
      return versions[`${name}@${spec}`]!;
    });

    expect(pkg).toEqual({
      dependencies: {
        "@clerk/react": "latest",
        react: "19.2.6",
        "already-exact": "1.2.3",
      },
      devDependencies: {
        typescript: "5.9.3",
      },
    });
    expect(resolved).toEqual(["react@^19.0.0", "typescript@~5.9.0"]);
  });

  test("resolves pinned dependency ranges to exact satisfying versions", async () => {
    const pkg = {
      dependencies: {
        "fixture-framework": "^1",
      },
    };

    await resolveDependencySpecsToExactVersions(pkg, async () => "1.2.3");

    expect(pkg.dependencies["fixture-framework"]).toBe("1.2.3");
    expect(validatePinnedDependencyRanges(pkg, { "fixture-framework": "^1" })).toEqual([]);
  });
});
