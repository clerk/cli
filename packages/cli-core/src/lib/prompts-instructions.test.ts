/**
 * The multiselect footer hack, checked against the real @clack/prompts.
 *
 * Kept out of `prompts.test.ts`, which mocks the whole module — the one thing
 * worth verifying here is that the real export is still a live array clack
 * reads at render time. A clack upgrade that froze it, replaced it, or rendered
 * a copy would drop `a: all` from the legend silently, and nothing else in the
 * suite would notice.
 */

import { test, expect } from "bun:test";
import { MULTISELECT_INSTRUCTIONS } from "@clack/prompts";

// Importing for the module-level side effect is the point.
await import("./prompts.ts");

const legend = () => MULTISELECT_INSTRUCTIONS.join(" • ").replaceAll(/\[[0-9;]*m/g, "");

test("the multiselect legend advertises select-all", () => {
  expect(legend()).toContain("a: all");
});

test("confirm stays last, where readers expect it", () => {
  expect(legend().endsWith("Enter: confirm")).toBe(true);
});

test("the keys clack actually binds are the ones named", () => {
  expect(legend()).toBe("↑/↓ to navigate • Space: select • a: all • Enter: confirm");
});
