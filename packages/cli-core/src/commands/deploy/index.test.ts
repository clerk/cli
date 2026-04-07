import { test, expect, describe, mock } from "bun:test";
import { testRoot } from "../../test/lib/test-root.ts";
import { deploy } from "./index.ts";

function dataCalls(deps: { log: { data: unknown } }): string[] {
  return ((deps.log.data as ReturnType<typeof mock>).mock.calls as unknown[][]).map((c) =>
    String(c[0] ?? ""),
  );
}
function infoCalls(deps: { log: { info: unknown } }): string[] {
  return ((deps.log.info as ReturnType<typeof mock>).mock.calls as unknown[][]).map((c) =>
    String(c[0] ?? ""),
  );
}

describe("deploy", () => {
  describe("agent mode", () => {
    function agentDeps() {
      return testRoot({
        mode: {
          isAgent: () => true,
          isHuman: () => false,
          getMode: () => "agent",
        },
      });
    }

    test("outputs deploy prompt and returns", async () => {
      const deps = agentDeps();
      await deploy(deps, {});

      expect(deps.log.data).toHaveBeenCalledTimes(1);
      const output = dataCalls(deps)[0]!;
      expect(output).toContain("deploying a Clerk application to production");
    });

    test("prompt includes all deployment steps", async () => {
      const deps = agentDeps();
      await deploy(deps, {});

      const output = dataCalls(deps)[0]!;
      expect(output).toContain("Prerequisites");
      expect(output).toContain("Verify Subscription Compatibility");
      expect(output).toContain("Choose a Production Domain");
      expect(output).toContain("Create the Production Instance");
      expect(output).toContain("Configure Social OAuth Providers");
      expect(output).toContain("Finalize");
    });

    test("prompt includes API reference", async () => {
      const deps = agentDeps();
      await deploy(deps, {});

      const output = dataCalls(deps)[0]!;
      expect(output).toContain("/v1/platform/applications");
      expect(output).toContain("instances/production/config");
      expect(output).toContain("instances/development/config");
    });

    test("prompt includes OAuth redirect URI pattern", async () => {
      const deps = agentDeps();
      await deploy(deps, {});

      const output = dataCalls(deps)[0]!;
      expect(output).toContain("accounts.{domain}/v1/oauth_callback");
    });

    test("does not trigger interactive prompts", async () => {
      const deps = agentDeps();

      await deploy(deps, { debug: true });

      expect(deps.prompts.select).not.toHaveBeenCalled();
      expect(deps.prompts.input).not.toHaveBeenCalled();
      expect(deps.prompts.confirm).not.toHaveBeenCalled();
      expect(deps.prompts.password).not.toHaveBeenCalled();
    });
  });

  describe("human mode", () => {
    function humanDeps() {
      // Domain selection then OAuth credential choice
      let selectCallCount = 0;
      return testRoot({
        prompts: {
          select: (async () => {
            selectCallCount += 1;
            return selectCallCount === 1 ? "clerk-subdomain" : "have-credentials";
          }) as never,
          input: (async () => "fake-client-id-12345") as never,
          password: (async () => "fake-secret") as never,
        },
      });
    }

    test("does not print deploy prompt", async () => {
      const deps = humanDeps();
      await deploy(deps, {});

      expect(dataCalls(deps).join("\n")).not.toContain(
        "deploying a Clerk application to production",
      );
    });

    test("shows mock banner", async () => {
      const deps = humanDeps();
      await deploy(deps, {});

      expect(infoCalls(deps).some((m) => m.includes("[mock]"))).toBe(true);
    });
  });
});
