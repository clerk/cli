import { test, expect, describe } from "bun:test";
import { pmInstallCommand, PACKAGE_MANAGERS } from "./package-manager.ts";

describe("pmInstallCommand hardening flags", () => {
  // `clerk init` spawns the project package manager in attacker-controlled
  // cwd. These flags are load-bearing — `--ignore-pnpmfile` blocks pnpm's
  // `.pnpmfile.cjs` autoload code-exec, `--ignore-scripts` blocks
  // lifecycle-script code-exec from the attacker's package.json. If any of
  // these drop, the install spawn regains its arbitrary-code-exec primitive.

  test.each([...PACKAGE_MANAGERS])("%s emits --ignore-scripts", (pm) => {
    expect(pmInstallCommand(pm)).toContain("--ignore-scripts");
  });

  test("pnpm additionally emits --ignore-pnpmfile", () => {
    expect(pmInstallCommand("pnpm")).toContain("--ignore-pnpmfile");
  });

  // heuristics.runPmInstall splits addCmd by " " and uses [0] as the binary
  // it probes via Bun.which(). A flag-prefixed binary would break that.
  test.each([...PACKAGE_MANAGERS])("%s install command starts with the bare binary", (pm) => {
    expect(pmInstallCommand(pm).split(" ")[0]).toBe(pm);
  });
});
