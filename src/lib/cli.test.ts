import { test, expect, beforeEach, describe, spyOn } from "bun:test";
import { setMode, setJsonFlag, isJSON } from "../mode";
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
      setJsonFlag(false);
    });

    test("emits JSON with passing checks on dispose", () => {
      {
        using out = createCommandOutput("init");
        out.add("authenticated", true, "Logged in");
        out.add("linked", true, "Application linked");
        out.add("framework", true, "Detected Next.js");
      }

      expect(logs).toHaveLength(1);
      const parsed = JSON.parse(logs[0]!);
      expect(parsed).toEqual({
        command: "init",
        checks: [
          { name: "authenticated", ok: true, detail: "Logged in" },
          { name: "linked", ok: true, detail: "Application linked" },
          { name: "framework", ok: true, detail: "Detected Next.js" },
        ],
      });
    });

    test("emits JSON with failing checks and fix suggestions", () => {
      {
        using out = createCommandOutput("deploy");
        out.add("authenticated", false, "Not authenticated", "clerk auth login");
        out.add("linked", false, "Not linked", "clerk link");
      }

      const parsed = JSON.parse(logs[0]!);
      expect(parsed).toEqual({
        command: "deploy",
        checks: [
          {
            name: "authenticated",
            ok: false,
            detail: "Not authenticated",
            fix: "clerk auth login",
          },
          { name: "linked", ok: false, detail: "Not linked", fix: "clerk link" },
        ],
        next: ["clerk auth login", "clerk link"],
      });
    });

    test("includes explicit suggestions in next steps", () => {
      {
        using out = createCommandOutput("link");
        out.add("authenticated", true, "Logged in");
        out.add("applications", true, "3 available: My App (app_abc123)");
        out.suggest("clerk link --app <app_id> (pick one from above)");
      }

      const parsed = JSON.parse(logs[0]!);
      expect(parsed).toEqual({
        command: "link",
        checks: [
          { name: "authenticated", ok: true, detail: "Logged in" },
          { name: "applications", ok: true, detail: "3 available: My App (app_abc123)" },
        ],
        next: ["clerk link --app <app_id> (pick one from above)"],
      });
    });

    test("combines fix suggestions from failed checks with explicit suggestions", () => {
      {
        using out = createCommandOutput("init");
        out.add("authenticated", false, "Not authenticated", "clerk auth login");
        out.suggest("clerk link");
      }

      const parsed = JSON.parse(logs[0]!);
      expect(parsed).toEqual({
        command: "init",
        checks: [
          {
            name: "authenticated",
            ok: false,
            detail: "Not authenticated",
            fix: "clerk auth login",
          },
        ],
        next: ["clerk auth login", "clerk link"],
      });
    });

    test("includes metadata in JSON output", () => {
      {
        using out = createCommandOutput("init");
        out.add("framework", true, "Detected Next.js");
        out.meta("recipe", "Add ClerkProvider to layout.tsx");
      }

      const parsed = JSON.parse(logs[0]!);
      expect(parsed).toEqual({
        command: "init",
        checks: [{ name: "framework", ok: true, detail: "Detected Next.js" }],
        meta: { recipe: "Add ClerkProvider to layout.tsx" },
      });
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

      const parsed = JSON.parse(logs[0]!);
      expect(parsed.next).toBeUndefined();
    });
  });

  describe("human mode", () => {
    beforeEach(() => {
      setMode("human");
      setJsonFlag(false);
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

    test("does not emit JSON on dispose", () => {
      {
        using out = createCommandOutput("init");
        out.add("authenticated", true, "Logged in");
        out.meta("recipe", "Add ClerkProvider to layout.tsx");
        out.suggest("clerk env pull");
      }

      // Only the add() line, no JSON
      expect(logs).toHaveLength(1);
    });
  });

  describe("isJSON", () => {
    beforeEach(() => {
      setMode("human");
      setJsonFlag(false);
    });

    test("returns true when in agent mode", () => {
      setMode("agent");
      expect(isJSON()).toBe(true);
    });

    test("returns true when json flag is set", () => {
      setMode("human");
      setJsonFlag(true);
      expect(isJSON()).toBe(true);
    });

    test("returns false in human mode without json flag", () => {
      setMode("human");
      setJsonFlag(false);
      expect(isJSON()).toBe(false);
    });
  });

  describe("json flag mode", () => {
    beforeEach(() => {
      setMode("human");
      setJsonFlag(true);
    });

    test("emits JSON on dispose even in human mode when json flag is set", () => {
      {
        using out = createCommandOutput("init");
        out.add("authenticated", true, "Logged in");
      }

      expect(logs).toHaveLength(1);
      const parsed = JSON.parse(logs[0]!);
      expect(parsed).toEqual({
        command: "init",
        checks: [{ name: "authenticated", ok: true, detail: "Logged in" }],
      });
    });
  });
});
