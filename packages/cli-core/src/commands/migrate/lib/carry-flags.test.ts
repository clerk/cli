import { describe, expect, test } from "bun:test";
import { NEXT_STEPS } from "../../../lib/next-steps.ts";
import { carryFlags } from "./carry-flags.ts";

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

  // `clerk migrate runs` takes no target flags.
  test("an import's next steps keep its flags, and `runs` only the runs folder", () => {
    const [runsLine, undoLine] = NEXT_STEPS.MIGRATE_DONE(
      "r1",
      carryFlags({ secretKey: "sk_test_x", runsDir: "/a b" }),
    );
    expect(runsLine).toContain("`clerk migrate runs r1 --runs-dir '/a b'`");
    expect(undoLine).toContain("`clerk migrate undo r1 --secret-key <key> --runs-dir '/a b'`");
  });
});
