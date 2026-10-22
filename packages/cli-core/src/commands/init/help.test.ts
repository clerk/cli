/**
 * What `clerk init --help` says `--fresh` replaces: the folder's existing
 * accountless app, which may be an SDK app whose claim link can't be used and
 * that may already be claimed, so the help never calls it unclaimed.
 */

import { describe, expect, test } from "bun:test";
import { createProgram } from "../../cli-program.ts";

describe("`clerk init --fresh` in the help", () => {
  const init = createProgram().commands.find((command) => command.name() === "init");
  const option = init?.options.find((entry) => entry.long === "--fresh")?.description ?? "";
  const example =
    Bun.stripANSI(init?.helpInformation() ?? "")
      .split("\n")
      .find((line) => line.includes("$ clerk init --accountless --fresh")) ?? "";

  test.each([
    { where: "the option", text: option },
    { where: "the example", text: example },
  ])("$where names the app it replaces without calling it unclaimed", ({ text }) => {
    expect(text).toContain("this folder's existing accountless app");
    expect(text).not.toContain("unclaimed");
  });

  test("the option says it also replaces an SDK app that may already be claimed", () => {
    expect(option).toContain(
      "including one a Clerk SDK created whose claim link can't be used, which may already be claimed",
    );
  });
});
