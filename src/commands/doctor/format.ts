import { dim, green, yellow, red } from "../../lib/color.ts";
import type { CheckResult, CheckStatus } from "./types.ts";

const STATUS_ICON: Record<CheckStatus, string> = {
  pass: green("✓"),
  warn: yellow("!"),
  fail: red("✗"),
};

export function formatCheckResult(result: CheckResult, verbose: boolean): string {
  const icon = STATUS_ICON[result.status];
  let line = `  ${icon} ${result.message}`;

  if (verbose && result.detail) {
    const indented = result.detail
      .split("\n")
      .map((l) => `      ${dim(l)}`)
      .join("\n");
    line += "\n" + indented;
  }

  if (result.status !== "pass" && result.remedy) {
    line += `\n      ${dim(result.remedy)}`;
  }

  return line;
}

export function formatJson(results: CheckResult[]): string {
  const sanitized = results.map(({ fix, ...rest }) => ({
    ...rest,
    ...(fix ? { fix: fix.label } : {}),
  }));
  return JSON.stringify(sanitized, null, 2);
}
