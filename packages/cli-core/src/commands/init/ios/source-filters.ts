import type { IOSDiagnostic, IOSSourceEvidence, IOSValueResolution } from "./types.ts";

export interface IOSSourceFilterContext {
  excluded: IOSValueResolution;
  included: IOSValueResolution;
}

// These are Xcode string lists, not whitespace-separated filenames: quotes
// and escaped spaces group one pattern. Preserve uncertain syntax rather
// than accidentally dropping a shipping source from the inspection.
function splitPatterns(value: string): string[] | undefined {
  const patterns: string[] = [];
  let token = "";
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "\\") {
      const next = value[++index];
      if (!next || !/[\s"'\\]/.test(next)) return undefined;
      token += next;
    } else if (character === quote) {
      quote = undefined;
    } else if (!quote && (character === '"' || character === "'")) {
      quote = character;
    } else if (!quote && /\s/.test(character)) {
      if (token) patterns.push(token);
      token = "";
    } else {
      token += character;
    }
  }
  if (quote) return undefined;
  if (token) patterns.push(token);
  return patterns;
}

function compilePattern(pattern: string): RegExp | undefined {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") expression += ".*";
    else if (character === "?") expression += ".";
    else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) return undefined;
      const members = pattern.slice(index + 1, end);
      // POSIX character classes, collating symbols, and escaped class syntax
      // require locale-aware fnmatch semantics that this inspector cannot prove.
      if (!/^!?[a-zA-Z0-9_-]+$/.test(members)) return undefined;
      expression += `[${members.startsWith("!") ? `^${members.slice(1)}` : members}]`;
      index = end;
    } else if (character === "\\" || character === "]") return undefined;
    else expression += character.replace(/[.+^${}()|]/g, "\\$&");
  }
  try {
    // Xcode matches names and path suffixes at directory boundaries, including
    // absolute paths. Matching is case-sensitive, even on a case-insensitive FS.
    return new RegExp(`(?:^|/)${expression}$`);
  } catch {
    return undefined;
  }
}

function resolvePatterns(resolution: IOSValueResolution): RegExp[] | undefined {
  if (resolution.state === "missing") return [];
  if (resolution.state !== "resolved") return undefined;
  const patterns = splitPatterns(resolution.value)?.map(compilePattern);
  return patterns?.every((pattern): pattern is RegExp => pattern !== undefined)
    ? patterns
    : undefined;
}

/** Filter shipping evidence without weakening the separate source-ownership check. */
export function filterIOSSwiftSources<T extends { absolutePath: string }>(
  sources: { files: T[]; complete: boolean },
  configurations: Array<{ sourceFilters: IOSSourceFilterContext[] }>,
  diagnostics: IOSDiagnostic[],
  evidence: IOSSourceEvidence,
): { files: T[]; complete: boolean } {
  const contexts = configurations.flatMap((configuration) => configuration.sourceFilters);
  const missingContexts =
    configurations.length === 0 ||
    configurations.some((config) => config.sourceFilters.length === 0);
  let uncertain = missingContexts;
  const filters = contexts.map((context) => ({
    excluded: resolvePatterns(context.excluded),
    included: resolvePatterns(context.included),
  }));
  uncertain ||= filters.some((filter) => !filter.excluded || !filter.included);
  const files = sources.files.filter((file) => {
    const included = filters.map((filter) => {
      if (!filter.excluded || !filter.included) return true;
      return (
        !filter.excluded.some((pattern) => pattern.test(file.absolutePath)) ||
        filter.included.some((pattern) => pattern.test(file.absolutePath))
      );
    });
    if (included.some(Boolean) && included.some((value) => !value)) uncertain = true;
    // A missing configuration might compile any file. Only discard files
    // proven excluded in every configuration, SDK, and architecture.
    return missingContexts || included.some(Boolean);
  });
  if (uncertain) {
    diagnostics.push({
      code: "xcode.incomplete-source-membership",
      severity: "warning",
      message:
        "Swift source exclusions are unresolved or select different files across build configurations, SDKs, or architectures; source-dependent edits require consistent membership.",
      remedy:
        "Resolve EXCLUDED_SOURCE_FILE_NAMES and INCLUDED_SOURCE_FILE_NAMES consistently before automating Swift edits.",
      evidence: [evidence],
    });
  }
  return { files, complete: sources.complete && !uncertain };
}
