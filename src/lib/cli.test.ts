import { test, expect, beforeEach, describe, spyOn } from "bun:test";
import { setMode } from "../mode";
import { createCommandOutput } from "./cli";

describe("createCommandOutput", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
  });

  describe("agent mode", () => {
    beforeEach(() => {
      setMode("agent");
    });

    test("emits TOON with passing checks on dispose", () => {
      {
        using out = createCommandOutput("init");
        out.add("authenticated", true, "Logged in");
        out.add("linked", true, "Application linked");
        out.add("framework", true, "Detected Next.js");
      }

      expect(logs).toMatchInlineSnapshot(`
        [
          
        "command: init
        checks[3]{name,ok,detail}:
          authenticated,true,Logged in
          linked,true,Application linked
          framework,true,Detected Next.js"
        ,
        ]
      `);
    });

    test("emits TOON with failing checks and fix suggestions", () => {
      {
        using out = createCommandOutput("deploy");
        out.add("authenticated", false, "Not authenticated", "clerk auth login");
        out.add("linked", false, "Not linked", "clerk link");
      }

      expect(logs).toMatchInlineSnapshot(`
        [
          
        "command: deploy
        checks[2]{name,ok,detail,fix}:
          authenticated,false,Not authenticated,clerk auth login
          linked,false,Not linked,clerk link
        next[2]: clerk auth login,clerk link"
        ,
        ]
      `);
    });

    test("includes explicit suggestions in next steps", () => {
      {
        using out = createCommandOutput("link");
        out.add("authenticated", true, "Logged in");
        out.add("applications", true, "3 available: My App (app_abc123)");
        out.suggest("clerk link --app <app_id> (pick one from above)");
      }

      expect(logs).toMatchInlineSnapshot(`
        [
          
        "command: link
        checks[2]{name,ok,detail}:
          authenticated,true,Logged in
          applications,true,"3 available: My App (app_abc123)"
        next[1]: clerk link --app <app_id> (pick one from above)"
        ,
        ]
      `);
    });

    test("combines fix suggestions from failed checks with explicit suggestions", () => {
      {
        using out = createCommandOutput("init");
        out.add("authenticated", false, "Not authenticated", "clerk auth login");
        out.suggest("clerk link");
      }

      expect(logs).toMatchInlineSnapshot(`
        [
          
        "command: init
        checks[1]{name,ok,detail,fix}:
          authenticated,false,Not authenticated,clerk auth login
        next[2]: clerk auth login,clerk link"
        ,
        ]
      `);
    });

    test("includes metadata in TOON output", () => {
      {
        using out = createCommandOutput("init");
        out.add("framework", true, "Detected Next.js");
        out.meta("recipe", "Add ClerkProvider to layout.tsx");
      }

      expect(logs).toMatchInlineSnapshot(`
        [
          
        "command: init
        checks[1]{name,ok,detail}:
          framework,true,Detected Next.js
        meta:
          recipe: Add ClerkProvider to layout.tsx"
        ,
        ]
      `);
    });

    test("does not print check lines immediately", () => {
      const out = createCommandOutput("deploy");
      out.add("authenticated", true, "Logged in");

      // No output yet — only on dispose
      expect(logs).toHaveLength(0);

      out[Symbol.dispose]();
      expect(logs).toHaveLength(1);
    });

    test("omits next when no fixes or suggestions", () => {
      {
        using out = createCommandOutput("unlink");
        out.add("linked", true, "Linked to app_abc123 in /path/to/repo");
        out.add("unlinked", true, "Unlinked app_abc123 from /path/to/repo");
      }

      const output = logs.join("\n");
      expect(output).not.toContain("next");
    });
  });

  describe("human mode", () => {
    beforeEach(() => {
      setMode("human");
    });

    test("prints check lines immediately on add", () => {
      const out = createCommandOutput("init");
      out.add("authenticated", true, "Logged in");

      expect(logs).toMatchInlineSnapshot(`
        [
          "  \x1B[32m✓\x1B[0m authenticated: Logged in",
        ]
      `);

      out.add("linked", false, "Not linked", "clerk link");

      expect(logs).toMatchInlineSnapshot(`
        [
          "  \x1B[32m✓\x1B[0m authenticated: Logged in",
          "  \x1B[33m✗\x1B[0m linked: Not linked (run: clerk link)",
        ]
      `);

      out[Symbol.dispose]();

      // No additional output on dispose in human mode
      expect(logs).toHaveLength(2);
    });

    test("does not emit TOON on dispose", () => {
      {
        using out = createCommandOutput("init");
        out.add("authenticated", true, "Logged in");
        out.meta("recipe", "Add ClerkProvider to layout.tsx");
        out.suggest("clerk env pull");
      }

      // Only the add() line, no TOON
      expect(logs).toHaveLength(1);
    });
  });
});
