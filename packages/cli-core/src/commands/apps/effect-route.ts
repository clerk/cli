/** Inspect only command words; parsing and validation belong to the selected parser. */
export function appsListRoute(args: readonly string[]): boolean {
  const words: string[] = [];
  let operands = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!operands && arg === "--") {
      operands = true;
      continue;
    }
    if (!operands && (arg === "--mode" || arg === "--input-json")) {
      i++;
      continue;
    }
    if (
      !operands &&
      ["--help", "-h", "--version", "-v"].includes(arg) &&
      (words[0] !== "apps" || words[1] !== "list")
    )
      return false;
    if (!operands && arg.startsWith("-")) continue;
    words.push(arg);
    if (words.length === 2 && words[0] !== "help") break;
    if (words.length === 3) break;
  }
  return (
    (words[0] === "apps" && words[1] === "list") ||
    (words[0] === "help" && words[1] === "apps" && words[2] === "list")
  );
}
