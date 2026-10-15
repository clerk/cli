import { describe, expect, test } from "bun:test";
import { carryFlags, undoCommand } from "./carry-flags.ts";

describe("carryFlags", () => {
  test("keeps the runs folder and target, with the key as a placeholder", () => {
    expect(
      carryFlags({ secretKey: "sk_test_x", app: "app_1", instance: "dev", runsDir: "/a b" }),
    ).toEqual([
      "--secret-key",
      "<key>",
      "--app",
      "app_1",
      "--instance",
      "dev",
      "--runs-dir",
      "'/a b'",
    ]);
  });

  test("an undo command keeps them, after the run ID", () => {
    expect(undoCommand("r1", carryFlags({ secretKey: "sk_test_x", runsDir: "/a b" }))).toBe(
      "clerk migrate undo r1 --secret-key <key> --runs-dir '/a b'",
    );
  });
});
