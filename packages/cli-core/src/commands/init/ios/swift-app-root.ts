export interface SwiftSourceRange {
  start: number;
  end: number;
}

export interface SwiftUIAppTypeRange extends SwiftSourceRange {
  declarationStart: number;
  openingBrace: number;
  closingBrace: number;
}

export interface SwiftUISceneBodyRange extends SwiftSourceRange {
  declarationStart: number;
  openingBrace: number;
  closingBrace: number;
}

export interface SwiftUIRootExpression extends SwiftSourceRange {
  containerStart: number;
  modifierStarts: number[];
}

export interface SwiftUIAppRootStructure {
  appType: SwiftUIAppTypeRange;
  body: SwiftUISceneBodyRange;
  root: SwiftUIRootExpression;
  clerkEnvironment: { found: boolean; conflicting: boolean };
  clerkOpenURLHandler: boolean;
}

export type SwiftUIAppRootInspection =
  | { status: "proven"; structure: SwiftUIAppRootStructure }
  | { status: "unsupported-app" }
  | { status: "unsupported-body" }
  | { status: "unsupported-scene" };

interface StructuralIndex {
  braceDepth: Int32Array;
  conditionalRanges: SwiftSourceRange[];
}

function skipWhitespace(source: string, start: number, end = source.length): number {
  let cursor = start;
  while (cursor < end && /\s/.test(source[cursor] ?? "")) cursor += 1;
  return cursor;
}

function trimWhitespaceEnd(source: string, start: number, end: number): number {
  let cursor = end;
  while (cursor > start && /\s/.test(source[cursor - 1] ?? "")) cursor -= 1;
  return cursor;
}

function matchingDelimiter(
  source: string,
  opening: number,
  openCharacter: "(" | "{" | "[",
  closeCharacter: ")" | "}" | "]",
): number | undefined {
  if (source[opening] !== openCharacter) return undefined;
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === openCharacter) depth += 1;
    if (source[index] !== closeCharacter) continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return undefined;
}

function matchingBrace(source: string, opening: number): number | undefined {
  return matchingDelimiter(source, opening, "{", "}");
}

function matchingParenthesis(source: string, opening: number): number | undefined {
  return matchingDelimiter(source, opening, "(", ")");
}

function structuralIndex(source: string): StructuralIndex {
  const braceDepth = new Int32Array(source.length + 1);
  for (let position = 0; position < source.length; position += 1) {
    braceDepth[position + 1] =
      braceDepth[position]! + (source[position] === "{" ? 1 : source[position] === "}" ? -1 : 0);
  }

  const conditionalRanges: SwiftSourceRange[] = [];
  const directive = /^[\t ]*#(if|elseif|else|endif)\b/gm;
  let depth = 0;
  let rangeStart: number | undefined;
  let match: RegExpExecArray | null;
  while ((match = directive.exec(source)) !== null) {
    if (match[1] === "if") {
      if (depth === 0) rangeStart = match.index;
      depth += 1;
    }
    if (match[1] === "endif" && depth > 0) {
      depth -= 1;
      if (depth === 0 && rangeStart != null) {
        conditionalRanges.push({ start: rangeStart, end: match.index });
        rangeStart = undefined;
      }
    }
  }
  if (rangeStart != null) conditionalRanges.push({ start: rangeStart, end: source.length });
  return { braceDepth, conditionalRanges };
}

function braceDepthAt(index: StructuralIndex, openingBrace: number, position: number): number {
  return index.braceDepth[position]! - index.braceDepth[openingBrace]!;
}

function isInsideConditionalCompilation(index: StructuralIndex, position: number): boolean {
  return index.conditionalRanges.some((range) => position >= range.start && position < range.end);
}

function appTypeRange(source: string, index: StructuralIndex): SwiftUIAppTypeRange | undefined {
  const mainMatches = [...source.matchAll(/@main\b/g)];
  if (mainMatches.length !== 1 || mainMatches[0]?.index == null) return undefined;
  const mainIndex = mainMatches[0].index;
  if (isInsideConditionalCompilation(index, mainIndex) || braceDepthAt(index, 0, mainIndex) !== 0) {
    return undefined;
  }

  let cursor = mainIndex + mainMatches[0][0].length;
  while (true) {
    cursor = skipWhitespace(source, cursor);
    const attribute = /^@[A-Za-z_][A-Za-z0-9_.]*/.exec(source.slice(cursor));
    if (attribute) {
      cursor += attribute[0].length;
      cursor = skipWhitespace(source, cursor);
      if (source[cursor] === "(") {
        const closing = matchingParenthesis(source, cursor);
        if (closing == null) return undefined;
        cursor = closing + 1;
      }
      continue;
    }
    const modifier = /^(?:public|internal|private|fileprivate|final|nonisolated)\b/.exec(
      source.slice(cursor),
    );
    if (!modifier) break;
    cursor += modifier[0].length;
  }

  cursor = skipWhitespace(source, cursor);
  const declaration = /^struct\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(cursor));
  if (!declaration) return undefined;
  const headerStart = cursor + declaration[0].length;
  const openingBrace = source.indexOf("{", headerStart);
  if (openingBrace === -1) return undefined;
  const header = source.slice(headerStart, openingBrace);
  if (/[;{}<>]/.test(header) || /\bwhere\b/.test(header)) return undefined;
  const inheritance = /^\s*:\s*([A-Za-z0-9_.,\s]+)\s*$/.exec(header)?.[1];
  if (!inheritance || !inheritance.split(",").some((item) => item.trim() === "App")) {
    return undefined;
  }
  const closingBrace = matchingBrace(source, openingBrace);
  if (closingBrace == null) return undefined;
  if (/^[\t ]*#(?:if|elseif|else|endif)\b/m.test(source.slice(openingBrace, closingBrace))) {
    return undefined;
  }
  return {
    start: mainIndex,
    end: closingBrace + 1,
    declarationStart: cursor,
    openingBrace,
    closingBrace,
  };
}

function bodyRange(
  source: string,
  appType: SwiftUIAppTypeRange,
  index: StructuralIndex,
): SwiftUISceneBodyRange | undefined {
  const candidates: SwiftUISceneBodyRange[] = [];
  const pattern = /\bvar\s+body\s*:\s*some\s+Scene\b/g;
  pattern.lastIndex = appType.openingBrace + 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null && match.index < appType.closingBrace) {
    if (braceDepthAt(index, appType.openingBrace, match.index) !== 1) continue;
    const openingBrace = skipWhitespace(source, match.index + match[0].length);
    if (source[openingBrace] !== "{") continue;
    const closingBrace = matchingBrace(source, openingBrace);
    if (closingBrace == null || closingBrace > appType.closingBrace) continue;
    const declarationLineStart = source.lastIndexOf("\n", Math.max(0, match.index - 1)) + 1;
    if (source.slice(declarationLineStart, match.index).trim() !== "") continue;
    candidates.push({
      start: match.index,
      end: closingBrace + 1,
      declarationStart: declarationLineStart,
      openingBrace,
      closingBrace,
    });
    pattern.lastIndex = closingBrace + 1;
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function identifierEnd(source: string, start: number): number | undefined {
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(start));
  return match ? start + match[0].length : undefined;
}

function consumeBalancedSuffix(source: string, cursor: number, limit: number): number | undefined {
  if (source[cursor] === "(") {
    const closing = matchingParenthesis(source, cursor);
    if (closing == null || closing >= limit) return undefined;
    cursor = skipWhitespace(source, closing + 1, limit);
    if (source[cursor] === "{") {
      const closureEnd = matchingBrace(source, cursor);
      if (closureEnd == null || closureEnd >= limit) return undefined;
      cursor = closureEnd + 1;
    }
    return cursor;
  }
  if (source[cursor] === "{") {
    const closureEnd = matchingBrace(source, cursor);
    if (closureEnd == null || closureEnd >= limit) return undefined;
    return closureEnd + 1;
  }
  return undefined;
}

function rootExpression(
  source: string,
  start: number,
  end: number,
  containerStart: number,
): SwiftUIRootExpression | undefined {
  let cursor = skipWhitespace(source, start, end);
  const expressionStart = cursor;
  let identifier = identifierEnd(source, cursor);
  if (identifier == null) return undefined;
  cursor = identifier;
  while (true) {
    const beforeDot = skipWhitespace(source, cursor, end);
    if (source[beforeDot] !== ".") break;
    const memberStart = skipWhitespace(source, beforeDot + 1, end);
    identifier = identifierEnd(source, memberStart);
    if (identifier == null) return undefined;
    const afterMember = skipWhitespace(source, identifier, end);
    if (source[afterMember] === "(" || source[afterMember] === "{") break;
    cursor = identifier;
  }
  cursor = skipWhitespace(source, cursor, end);
  const primaryEnd = consumeBalancedSuffix(source, cursor, end);
  if (primaryEnd == null) return undefined;
  cursor = primaryEnd;

  const modifierStarts: number[] = [];
  while (true) {
    cursor = skipWhitespace(source, cursor, end);
    if (source[cursor] !== ".") break;
    const modifierStart = cursor;
    const nameStart = skipWhitespace(source, cursor + 1, end);
    const nameEnd = identifierEnd(source, nameStart);
    if (nameEnd == null) return undefined;
    cursor = skipWhitespace(source, nameEnd, end);
    const suffixEnd = consumeBalancedSuffix(source, cursor, end);
    if (suffixEnd == null) return undefined;
    modifierStarts.push(modifierStart);
    cursor = suffixEnd;
  }
  cursor = skipWhitespace(source, cursor, end);
  if (cursor !== end) return undefined;
  return {
    start: expressionStart,
    end: trimWhitespaceEnd(source, expressionStart, end),
    containerStart,
    modifierStarts,
  };
}

function windowGroupRoot(
  source: string,
  body: SwiftUISceneBodyRange,
): SwiftUIRootExpression | undefined {
  let cursor = skipWhitespace(source, body.openingBrace + 1, body.closingBrace);
  const windowGroupStart = cursor;
  if (!source.slice(cursor).startsWith("WindowGroup")) return undefined;
  const wordEnd = cursor + "WindowGroup".length;
  if (/[A-Za-z0-9_]/.test(source[wordEnd] ?? "")) return undefined;
  cursor = skipWhitespace(source, wordEnd, body.closingBrace);
  if (source[cursor] === "(") {
    const closingParenthesis = matchingParenthesis(source, cursor);
    if (closingParenthesis == null || closingParenthesis >= body.closingBrace) return undefined;
    cursor = skipWhitespace(source, closingParenthesis + 1, body.closingBrace);
  }
  if (source[cursor] !== "{") return undefined;
  const groupClosingBrace = matchingBrace(source, cursor);
  if (groupClosingBrace == null || groupClosingBrace >= body.closingBrace) return undefined;
  if (skipWhitespace(source, groupClosingBrace + 1, body.closingBrace) !== body.closingBrace) {
    return undefined;
  }
  const expressionStart = skipWhitespace(source, cursor + 1, groupClosingBrace);
  const expressionEnd = trimWhitespaceEnd(source, expressionStart, groupClosingBrace);
  if (expressionStart === expressionEnd) return undefined;
  return rootExpression(source, expressionStart, expressionEnd, windowGroupStart);
}

function modifierDetails(
  source: string,
  root: SwiftUIRootExpression,
  modifierStart: number,
):
  | { name: string; openingParenthesis?: number; closingParenthesis?: number; body?: string }
  | undefined {
  const remainder = source.slice(modifierStart, root.end);
  const name = /^\.\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(remainder)?.[1];
  if (!name) return undefined;
  const nameEnd = modifierStart + (remainder.indexOf(name) + name.length);
  const suffixStart = skipWhitespace(source, nameEnd, root.end);
  if (source[suffixStart] === "(") {
    const closingParenthesis = matchingParenthesis(source, suffixStart);
    if (closingParenthesis == null || closingParenthesis > root.end) return { name };
    const closureStart = skipWhitespace(source, closingParenthesis + 1, root.end);
    const closureEnd =
      source[closureStart] === "{" ? matchingBrace(source, closureStart) : undefined;
    return {
      name,
      openingParenthesis: suffixStart,
      closingParenthesis,
      body:
        closureEnd == null
          ? source.slice(suffixStart + 1, closingParenthesis)
          : source.slice(closureStart + 1, closureEnd),
    };
  }
  if (source[suffixStart] === "{") {
    const closureEnd = matchingBrace(source, suffixStart);
    return closureEnd == null
      ? { name }
      : { name, body: source.slice(suffixStart + 1, closureEnd) };
  }
  return { name };
}

function clerkEnvironment(
  source: string,
  root: SwiftUIRootExpression,
): { found: boolean; conflicting: boolean } {
  let found = false;
  let conflicting = false;
  for (const modifierStart of root.modifierStarts) {
    const modifier = modifierDetails(source, root, modifierStart);
    if (modifier?.name !== "environment") continue;
    if (modifier.openingParenthesis == null || modifier.closingParenthesis == null) {
      conflicting = true;
      continue;
    }
    const argumentsSource = source.slice(
      modifier.openingParenthesis + 1,
      modifier.closingParenthesis,
    );
    if (/^\s*Clerk\s*\.\s*shared\s*$/.test(argumentsSource)) {
      found = true;
    } else if (/\bClerk\s*\.\s*shared\b/.test(argumentsSource)) {
      conflicting = true;
    }
  }
  return { found, conflicting };
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function onOpenURLClosureBody(body: string): string | undefined {
  const trimmed = body.trim();
  const wrapper = /^(?:perform\s*:\s*)?\{/.exec(trimmed);
  if (!wrapper) return trimmed;
  const openingBrace = trimmed.indexOf("{", wrapper.index);
  const closingBrace = matchingBrace(trimmed, openingBrace);
  if (closingBrace == null || trimmed.slice(closingBrace + 1).trim() !== "") return undefined;
  return trimmed.slice(openingBrace + 1, closingBrace);
}

function closureURLBinding(body: string): { parameter: string; bodyStart: number } | undefined {
  const captureList = /^\s*\[[^\]]*\]\s*/.exec(body)?.[0] ?? "";
  const header = body.slice(captureList.length);
  const parenthesized = /^\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^)]*)?\)\s+in\b/.exec(header);
  if (parenthesized?.[1]) {
    return {
      parameter: parenthesized[1],
      bodyStart: captureList.length + parenthesized[0].length,
    };
  }
  const named = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+in\b/.exec(header);
  return named?.[1]
    ? { parameter: named[1], bodyStart: captureList.length + named[0].length }
    : undefined;
}

function isExactClerkOpenURLForwarder(body: string, parameter: string): boolean {
  const escaped = regexEscape(parameter);
  const forwarder = new RegExp(
    `^\\s*Task\\s*\\{\\s*(?:_\\s*=\\s*)?try[!?]?\\s+await\\s+Clerk\\s*\\.\\s*shared\\s*\\.\\s*handle\\s*\\(\\s*${escaped}\\s*\\)\\s*;?\\s*\\}\\s*$`,
  );
  return forwarder.test(body);
}

function hasClerkOpenURLHandler(source: string, root: SwiftUIRootExpression): boolean {
  return root.modifierStarts.some((modifierStart) => {
    const modifier = modifierDetails(source, root, modifierStart);
    if (modifier?.name !== "onOpenURL" || modifier.body == null) return false;
    const closureBody = onOpenURLClosureBody(modifier.body);
    if (!closureBody) return false;
    const binding = closureURLBinding(closureBody);
    if (!binding || binding.parameter === "_") return false;
    const handlerBody = closureBody.slice(binding.bodyStart);
    return isExactClerkOpenURLForwarder(handlerBody, binding.parameter);
  });
}

/**
 * Proves only the narrow shipping SwiftUI root that Clerk can reason about
 * deterministically: one unconditional top-level `@main` App, one
 * `body: some Scene`, one WindowGroup, and one direct root expression.
 */
export function inspectSwiftUIAppRootWithStatus(source: string): SwiftUIAppRootInspection {
  const index = structuralIndex(source);
  const appType = appTypeRange(source, index);
  if (!appType) return { status: "unsupported-app" };
  const body = bodyRange(source, appType, index);
  if (!body) return { status: "unsupported-body" };
  const root = windowGroupRoot(source, body);
  if (!root) return { status: "unsupported-scene" };
  return {
    status: "proven",
    structure: {
      appType,
      body,
      root,
      clerkEnvironment: clerkEnvironment(source, root),
      clerkOpenURLHandler: hasClerkOpenURLHandler(source, root),
    },
  };
}

export function inspectSwiftUIAppRoot(source: string): SwiftUIAppRootStructure | undefined {
  const result = inspectSwiftUIAppRootWithStatus(source);
  return result.status === "proven" ? result.structure : undefined;
}
