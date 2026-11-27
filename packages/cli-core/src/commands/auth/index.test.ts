import { afterEach, describe, expect, mock, test } from "bun:test";
import { Command } from "@commander-js/extra-typings";
import "../../lib/help.ts";

const mockLogin = mock();
mock.module("./login.ts", () => ({
  login: (...args: unknown[]) => mockLogin(...args),
}));
mock.module("./logout.ts", () => ({ logout: async () => {} }));
mock.module("../../lib/banner.ts", () => ({ printBanner: () => {} }));

const { registerAuth } = await import("./index.ts");

describe("registerAuth", () => {
  afterEach(() => {
    mockLogin.mockReset();
  });

  // Only these commands check the folder's keys after a claim; `clerk init`, `clerk migrate`
  // and `clerk doctor` call `login()` without the option.
  test.each([[["auth", "login"]], [["login"]]])(
    "`clerk %p` signs in with the claim key check on",
    async (args) => {
      const program = new Command();
      registerAuth(program as never);

      await program.parseAsync(args, { from: "user" });

      expect(mockLogin).toHaveBeenCalledWith(expect.objectContaining({ checkClaimKeys: true }));
    },
  );
});
