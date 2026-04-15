/**
 * Shell completion integration tests
 * Tests generateCompletions against the real CLI command tree from createProgram().
 */

import { test, expect, describe } from "bun:test";
import { useIntegrationTestHarness } from "./lib/harness.ts";
import { generateCompletions } from "../../commands/completion/__complete.ts";
import { createProgram } from "../../cli-program.ts";

useIntegrationTestHarness();

const program = createProgram();

function completionNames(...args: string[]): string[] {
  return generateCompletions(program, args).completions.map((c) => c.name);
}

function complete(...args: string[]) {
  return generateCompletions(program, args);
}

describe("generateCompletions", () => {
  describe("subcommand completion", () => {
    test("completes root subcommands alongside options", () => {
      const names = completionNames("");
      expect(names).toContain("auth");
      expect(names).toContain("init");
      expect(names).toContain("link");
      expect(names).toContain("whoami");
      expect(names).toContain("config");
      expect(names).toContain("api");
      expect(names).toContain("completion");
      expect(names).toContain("env");
      expect(names).toContain("doctor");
      // Options are also included
      expect(names).toContain("--verbose");
      expect(names).toContain("--mode");
    });

    test("excludes hidden commands", () => {
      expect(completionNames("")).not.toContain("deploy");
    });

    test("completes partial subcommand name", () => {
      const names = completionNames("au");
      expect(names).toContain("auth");
      expect(names).not.toContain("link");
    });

    test("completes nested subcommands alongside options", () => {
      const names = completionNames("auth", "");
      expect(names).toContain("login");
      expect(names).toContain("logout");
      expect(names).toContain("--verbose");
      expect(names).toContain("--mode");
    });

    test("completes partial nested subcommand", () => {
      const names = completionNames("auth", "log");
      expect(names).toContain("login");
      expect(names).toContain("logout");
    });

    test("includes descriptions", () => {
      const result = complete("au");
      expect(result.completions).toContainEqual({
        name: "auth",
        description: "Manage authentication",
      });
    });

    test("completes deeply nested subcommands", () => {
      const names = completionNames("config", "");
      expect(names).toContain("pull");
      expect(names).toContain("schema");
      expect(names).toContain("patch");
      expect(names).toContain("put");
    });
  });

  describe("alias completion", () => {
    test("completes command aliases", () => {
      const names = completionNames("auth", "");
      expect(names).toContain("signup");
      expect(names).toContain("signin");
      expect(names).toContain("sign-in");
      expect(names).toContain("signout");
      expect(names).toContain("sign-out");
    });

    test("completes partial alias", () => {
      const names = completionNames("auth", "sign");
      expect(names).toContain("signup");
      expect(names).toContain("signin");
      expect(names).toContain("sign-in");
      expect(names).toContain("signout");
      expect(names).toContain("sign-out");
      expect(names).not.toContain("login");
      expect(names).not.toContain("logout");
    });

    test("navigates via alias to leaf command", () => {
      const names = completionNames("auth", "signup", "--");
      expect(names).toContain("--verbose");
      expect(names).not.toContain("login");
    });
  });

  describe("option completion", () => {
    test("completes options with -- prefix", () => {
      const names = completionNames("--");
      expect(names).toContain("--verbose");
      expect(names).toContain("--mode");
    });

    test("completes subcommand-specific options", () => {
      const names = completionNames("link", "--");
      expect(names).toContain("--app");
    });

    test("includes global options in subcommands", () => {
      const names = completionNames("link", "--");
      expect(names).toContain("--verbose");
      expect(names).toContain("--mode");
    });

    test("includes global options in nested subcommands", () => {
      const names = completionNames("config", "pull", "--");
      expect(names).toContain("--instance");
      expect(names).toContain("--output");
      expect(names).toContain("--verbose");
    });

    test("excludes already-used boolean options", () => {
      const names = completionNames("init", "--yes", "--");
      expect(names).not.toContain("--yes");
      expect(names).toContain("--framework");
    });

    test("registers --app on init (advertised in examples, wired to authenticateAndLink)", () => {
      const names = completionNames("init", "--");
      expect(names).toContain("--app");
    });

    test("completes partial option name", () => {
      const names = completionNames("--ver");
      expect(names).toContain("--verbose");
      expect(names).not.toContain("--mode");
    });
  });

  describe("option value completion", () => {
    test("completes --mode values", () => {
      const names = completionNames("--mode", "");
      expect(names).toContain("human");
      expect(names).toContain("agent");
    });

    test("completes partial --mode value", () => {
      const names = completionNames("--mode", "h");
      expect(names).toContain("human");
      expect(names).not.toContain("agent");
    });

    test("completes --framework values for init", () => {
      const names = completionNames("init", "--framework", "");
      expect(names).toContain("next");
      expect(names).toContain("astro");
      expect(names).toContain("react");
      expect(names).toContain("vue");
    });

    test("completes partial --framework value", () => {
      const names = completionNames("init", "--framework", "n");
      expect(names).toContain("next");
      expect(names).toContain("nuxt");
      expect(names).not.toContain("react");
    });

    test("completes --instance values", () => {
      const names = completionNames("config", "pull", "--instance", "");
      expect(names).toContain("dev");
      expect(names).toContain("prod");
    });

    test("completes --method / -X values", () => {
      const names = completionNames("api", "--method", "");
      expect(names).toContain("GET");
      expect(names).toContain("POST");
      expect(names).toContain("PUT");
      expect(names).toContain("PATCH");
      expect(names).toContain("DELETE");
    });

    test("returns empty for options with unknown values (file paths)", () => {
      const result = complete("config", "pull", "--output", "");
      expect(result.completions).toEqual([]);
      expect(result.directive).toBe(0);
    });

    test("skips option values when walking", () => {
      const names = completionNames("link", "--app", "some-id", "--");
      expect(names).toContain("--verbose");
      expect(names).not.toContain("--app");
    });
  });

  describe("positional argument completion", () => {
    test("completes argument choices alongside options", () => {
      const names = completionNames("completion", "");
      expect(names).toContain("bash");
      expect(names).toContain("zsh");
      expect(names).toContain("fish");
      expect(names).toContain("powershell");
      expect(names).toContain("--verbose");
    });

    test("completes partial argument choice", () => {
      const names = completionNames("completion", "b");
      expect(names).toContain("bash");
      expect(names).not.toContain("zsh");
    });

    test("falls back to flags for commands with free-form args", () => {
      const names = completionNames("api", "");
      expect(names).toContain("--method");
      expect(names).toContain("--verbose");
    });

    test("tracks positional argument position", () => {
      const names = completionNames("api", "/users", "");
      expect(names).toContain("--method");
    });

    test("still shows options with -- prefix after positional args", () => {
      const names = completionNames("api", "/users", "--");
      expect(names).toContain("--method");
    });

    test("open dashboard: suggests known subpaths", () => {
      const names = completionNames("open", "dashboard", "");
      expect(names).toContain("users");
      expect(names).toContain("api-keys");
      expect(names).toContain("settings");
    });

    test("open dashboard: filters subpaths by prefix", () => {
      const names = completionNames("open", "dashboard", "u");
      expect(names).toContain("users");
      expect(names).toContain("user-authentication");
      expect(names).not.toContain("api-keys");
    });
  });

  describe("directives", () => {
    test("sets NO_FILE_COMP for subcommand completions", () => {
      expect(complete("").directive & 4).toBe(4);
    });

    test("sets NO_FILE_COMP for option completions", () => {
      expect(complete("--").directive & 4).toBe(4);
    });

    test("sets DEFAULT for unknown option values", () => {
      expect(complete("config", "pull", "--output", "").directive).toBe(0);
    });

    test("sets NO_FILE_COMP for commands with free-form positional args (falls back to flags)", () => {
      expect(complete("api", "").directive & 4).toBe(4);
    });

    test("sets NO_FILE_COMP for argument choices", () => {
      expect(complete("completion", "").directive & 4).toBe(4);
    });
  });

  describe("edge cases", () => {
    test("handles empty args", () => {
      const names = completionNames();
      expect(names).toContain("auth");
      expect(names).toContain("link");
    });

    test("handles unknown words gracefully", () => {
      expect(complete("nonexistent", "").completions).toBeDefined();
    });

    test("handles completion after leaf command with -- prefix", () => {
      expect(completionNames("whoami", "--")).toContain("--verbose");
    });

    test("leaf command without -- shows global flags as fallback", () => {
      const names = completionNames("whoami", "");
      expect(names).toContain("--verbose");
    });
  });
});
