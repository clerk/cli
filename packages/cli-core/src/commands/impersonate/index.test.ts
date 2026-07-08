import { test, expect, describe } from "bun:test";
import { createProgram } from "../../cli-program.ts";

describe("impersonate command wiring", () => {
  test("registers `impersonate` with `imp` alias and an optional `[user]` argument", () => {
    const program = createProgram();
    const impersonateCommand = program.commands.find((c) => c.name() === "impersonate");

    expect(impersonateCommand).toBeDefined();
    expect(impersonateCommand?.aliases()).toContain("imp");
    expect(impersonateCommand?.registeredArguments[0]?.name()).toBe("user");
    expect(impersonateCommand?.registeredArguments[0]?.required).toBe(false);
  });

  test("registers a required `revoke <actorTokenId>` subcommand", () => {
    const program = createProgram();
    const impersonateCommand = program.commands.find((c) => c.name() === "impersonate");
    const revokeCommand = impersonateCommand?.commands.find((c) => c.name() === "revoke");

    expect(revokeCommand).toBeDefined();
    expect(revokeCommand?.registeredArguments[0]?.name()).toBe("actorTokenId");
    expect(revokeCommand?.registeredArguments[0]?.required).toBe(true);
  });
});
