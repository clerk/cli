import { test, expect, describe } from "bun:test";
import { pmInstallCommand, PACKAGE_MANAGERS } from "./package-manager.ts";

describe("pmInstallCommand hardening flags", () => {
  // AIE-969: `clerk init` spawns the project package manager in attacker-
  // controlled cwd. These flags are load-bearing — `--ignore-pnpmfile` blocks
  // pnpm's `.pnpmfile.cjs` autoload code-exec, `--ignore-scripts` blocks
  // lifecycle-script code-exec from the attacker's package.json. If any of
  // these drop, the install spawn regains its arbitrary-code-exec primitive.

  test("every package manager emits --ignore-scripts", () => {
    for (const pm of PACKAGE_MANAGERS) {
      expect(pmInstallCommand(pm)).toContain("--ignore-scripts");
    }
  });

  test("pnpm additionally emits --ignore-pnpmfile", () => {
    expect(pmInstallCommand("pnpm")).toContain("--ignore-pnpmfile");
  });

  test("first token is the bare binary name (spawn tokenization)", () => {
    // heuristics.runPmInstall splits addCmd by " " and uses [0] as the binary
    // it probes via Bun.which(). A flag-prefixed binary would break that.
    expect(pmInstallCommand("bun").split(" ")[0]).toBe("bun");
    expect(pmInstallCommand("pnpm").split(" ")[0]).toBe("pnpm");
    expect(pmInstallCommand("yarn").split(" ")[0]).toBe("yarn");
    expect(pmInstallCommand("npm").split(" ")[0]).toBe("npm");
  });
});
