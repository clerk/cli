import * as plistModule from "@expo/plist";

interface IOSPlistParser {
  parse(source: string): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * @expo/plist is CommonJS. Bun exposes it directly while running source, but
 * can wrap the same export in one or more `default` properties when bundling
 * the CLI. Resolve both representations before parsing any project plist.
 */
export function normalizeIOSPlistModule(module: unknown): IOSPlistParser {
  let candidate = module;

  for (let depth = 0; depth < 4 && isRecord(candidate); depth += 1) {
    const parse = candidate.parse;
    if (typeof parse === "function") {
      const receiver = candidate;
      return {
        parse: (source) => parse.call(receiver, source),
      };
    }
    candidate = candidate.default;
  }

  throw new TypeError("@expo/plist does not expose a compatible parser");
}

const plist = normalizeIOSPlistModule(plistModule);

export function parseIOSPlist(source: string): unknown {
  return plist.parse(source);
}
