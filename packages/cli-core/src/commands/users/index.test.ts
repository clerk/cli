import { test, expect, describe, beforeEach } from "bun:test";

describe("users action registry", () => {
  beforeEach(async () => {
    const mod = await import("./index.ts");
    mod.__resetUsersActionRegistryForTesting();
  });

  test("registerUsersAction appends to listUsersActions in order", async () => {
    const { registerUsersAction, listUsersActions } = await import("./index.ts");
    registerUsersAction({ key: "a", label: "A", description: "first", handler: async () => {} });
    registerUsersAction({ key: "b", label: "B", description: "second", handler: async () => {} });
    expect(listUsersActions().map((a) => a.key)).toEqual(["a", "b"]);
  });

  test("listUsersActions returns a frozen view (not a mutable reference)", async () => {
    const { registerUsersAction, listUsersActions } = await import("./index.ts");
    registerUsersAction({ key: "a", label: "A", description: "x", handler: async () => {} });
    const view = listUsersActions();
    expect(() => (view as unknown as Array<unknown>).push("nope")).toThrow();
  });
});
