import { readFile } from "node:fs/promises";
import { decodePublishableKey } from "../../../lib/fapi.ts";
import type {
  IOSConfigureCallEvidence,
  IOSInlinePublishableKeyInspection,
  IOSPublishableKeyWiring,
  IOSSourceEvidence,
  IOSSwiftInspection,
} from "./types.ts";

const MAX_SWIFT_FILE_BYTES = 1_000_000;

const CLERK_CONFIGURE_CALL = /\bClerk\s*\.\s*configure\s*\(/;
const CLERK_URL_HANDLER = /\b(?:Clerk\s*\.\s*shared|clerk)\s*\.\s*handle\s*\(/;
const CLERK_NATIVE_AUTH_FLOW =
  /\b(?:Clerk\s*\.\s*shared|clerk)\s*\.\s*auth\s*\.\s*(?:signIn(?:With(?:Password|EmailCode|EmailLink|PhoneCode|OAuth|IdToken|Apple|Passkey|EnterpriseSSO|Ticket))?|signUp(?:With(?:OAuth|Apple|IdToken|EnterpriseSSO|Ticket))?|startHostedAuth)\s*\(/;
const CLERK_ENVIRONMENT_INJECTION =
  /\.\s*environment\s*\(\s*(?:\\?\.\s*self\s*,\s*)?Clerk\s*\.\s*shared\s*\)/;
const CLERK_ENVIRONMENT_CONSUMER = /@Environment\s*\(\s*Clerk\s*\.\s*self\s*\)/;
const CLERK_AUTH_VIEW = /\bAuthView\s*\(/;
const CLERK_KIT_IMPORT =
  /\bimport\s+(?:(?:typealias|struct|class|enum|protocol|actor|let|var|func|macro)\s+)?ClerkKit\b/;
const CLERK_KIT_UI_IMPORT =
  /\bimport\s+(?:(?:typealias|struct|class|enum|protocol|actor|let|var|func|macro)\s+)?ClerkKitUI\b/;

function blankRange(chars: string[], start: number, end: number): void {
  for (let i = start; i < end; i++) {
    if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
  }
}

export interface SwiftSourceSanitization {
  sanitizedSource: string;
  complete: boolean;
}

function hasExactHashes(chars: string[], start: number, hashCount: number): boolean {
  if (hashCount === 0) return true;
  for (let hash = 0; hash < hashCount; hash++) {
    if (chars[start + hash] !== "#") return false;
  }
  return chars[start + hashCount] !== "#";
}

function isBareRegexOpening(chars: string[], index: number): boolean {
  const first = chars[index + 1];
  if (first == null || first === " " || first === "\t" || first === "\n" || first === "\r") {
    return false;
  }
  if (first === "=") return false;

  if (index === 0) return true;
  const previous = chars[index - 1];
  return /\s/.test(previous ?? "") || "([{,:;".includes(previous ?? "");
}

function consumeRegexLiteral(
  chars: string[],
  openingSlash: number,
  hashCount: number,
): { end: number; complete: boolean } {
  let cursor = openingSlash + 1;

  while (cursor < chars.length) {
    if (hashCount === 0 && (chars[cursor] === "\n" || chars[cursor] === "\r")) {
      return { end: cursor, complete: false };
    }

    if (chars[cursor] === "\\") {
      let escapeHashes = 0;
      while (chars[cursor + 1 + escapeHashes] === "#") escapeHashes++;
      if (escapeHashes === hashCount && chars[cursor + 1 + escapeHashes] === "(") {
        // Regex interpolation contains arbitrary Swift expressions. Without a
        // full Swift parser, a delimiter inside the expression cannot be
        // distinguished safely from the regex's closing delimiter.
        return { end: chars.length, complete: false };
      }
      cursor = Math.min(chars.length, cursor + 2);
      continue;
    }

    if (chars[cursor] === "/" && hasExactHashes(chars, cursor + 1, hashCount)) {
      if (hashCount === 0 && (chars[cursor - 1] === " " || chars[cursor - 1] === "\t")) {
        return { end: cursor + 1, complete: false };
      }
      return { end: cursor + 1 + hashCount, complete: true };
    }

    cursor++;
  }

  return { end: chars.length, complete: false };
}

const CLERK_EVIDENCE_PATTERNS = [
  CLERK_CONFIGURE_CALL,
  CLERK_URL_HANDLER,
  CLERK_NATIVE_AUTH_FLOW,
  CLERK_ENVIRONMENT_INJECTION,
  CLERK_ENVIRONMENT_CONSUMER,
  CLERK_AUTH_VIEW,
];

function evidenceCount(source: string, pattern: RegExp): number {
  return source.match(new RegExp(pattern.source, "g"))?.length ?? 0;
}

function hidesClerkEvidence(source: string, sanitizedSource: string): boolean {
  return CLERK_EVIDENCE_PATTERNS.some(
    (pattern) => evidenceCount(source, pattern) > evidenceCount(sanitizedSource, pattern),
  );
}

/**
 * Removes comments and string contents while preserving offsets and newlines.
 * This is intentionally a small lexer rather than a regex: Swift supports
 * nested block comments, multiline strings, and arbitrary raw-string hashes.
 */
function sanitizeSwift(source: string, blankStrings: boolean): SwiftSourceSanitization {
  // Swift source offsets below are JavaScript UTF-16 indexes. Split into code
  // units so blanking an emoji or other astral character never shifts later
  // slices into the original source.
  const chars = source.split("");
  let i = 0;
  let complete = true;
  let hasStringInterpolation = false;

  while (i < chars.length) {
    if (chars[i] === "/" && chars[i + 1] === "/") {
      const start = i;
      i += 2;
      while (i < chars.length && chars[i] !== "\n") i++;
      blankRange(chars, start, i);
      continue;
    }

    if (chars[i] === "/" && chars[i + 1] === "*") {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < chars.length && depth > 0) {
        if (chars[i] === "/" && chars[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (chars[i] === "*" && chars[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) complete = false;
      blankRange(chars, start, i);
      continue;
    }

    let hashCount = 0;
    while (chars[i + hashCount] === "#") hashCount++;
    const delimiterIndex = i + hashCount;

    if (hashCount > 0 && chars[delimiterIndex] === "/") {
      const literal = consumeRegexLiteral(chars, delimiterIndex, hashCount);
      blankRange(chars, i, literal.end);
      complete &&= literal.complete;
      i = literal.end;
      continue;
    }

    if (hashCount === 0 && chars[i] === "/" && isBareRegexOpening(chars, i)) {
      const literal = consumeRegexLiteral(chars, i, 0);
      blankRange(chars, i, literal.end);
      complete &&= literal.complete;
      i = literal.end;
      continue;
    }

    const quoteIndex = delimiterIndex;
    if (chars[quoteIndex] !== '"') {
      i++;
      continue;
    }

    const start = i;
    const multiline =
      chars[quoteIndex] === '"' && chars[quoteIndex + 1] === '"' && chars[quoteIndex + 2] === '"';
    i = quoteIndex + (multiline ? 3 : 1);
    let closed = false;

    while (i < chars.length) {
      const closesQuote = multiline
        ? chars[i] === '"' && chars[i + 1] === '"' && chars[i + 2] === '"'
        : chars[i] === '"';

      if (closesQuote) {
        const quoteLength = multiline ? 3 : 1;
        let closesHashes = true;
        for (let h = 0; h < hashCount; h++) {
          if (chars[i + quoteLength + h] !== "#") closesHashes = false;
        }
        if (closesHashes) {
          i += quoteLength + hashCount;
          closed = true;
          break;
        }
      }

      // Backslash escapes apply directly in normal strings and only when
      // followed by the matching number of hashes in raw strings.
      if (chars[i] === "\\") {
        let escapeHashes = 0;
        while (chars[i + 1 + escapeHashes] === "#") escapeHashes++;
        if (escapeHashes === hashCount) {
          const escapedCharacter = i + 1 + escapeHashes;
          if (chars[escapedCharacter] === "(") hasStringInterpolation = true;
          i = escapedCharacter + 1;
          continue;
        }
      }
      i++;
    }

    if (!closed) complete = false;
    if (blankStrings) blankRange(chars, start, i);
  }

  const sanitizedSource = chars.join("");
  if (hasStringInterpolation && hidesClerkEvidence(source, sanitizedSource)) complete = false;
  return { sanitizedSource, complete };
}

export function sanitizeSwiftSource(source: string): string {
  return sanitizeSwiftSourceWithStatus(source).sanitizedSource;
}

export function sanitizeSwiftSourceWithStatus(source: string): SwiftSourceSanitization {
  return sanitizeSwift(source, true);
}

function has(source: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  return pattern.test(source);
}

function matchingBrace(source: string, openingBrace: number): number | undefined {
  let depth = 0;
  for (let index = openingBrace; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] !== "}") continue;
    depth--;
    if (depth === 0) return index;
  }
  return undefined;
}

function matchingParenthesis(source: string, openingParenthesis: number): number | undefined {
  let depth = 0;
  for (let index = openingParenthesis; index < source.length; index++) {
    if (source[index] === "(") depth++;
    if (source[index] !== ")") continue;
    depth--;
    if (depth === 0) return index;
  }
  return undefined;
}

interface SourceBodyRange {
  openingBrace: number;
  closingBrace: number;
}

const TYPE_DECLARATION_MODIFIERS = new Set([
  "final",
  "fileprivate",
  "indirect",
  "internal",
  "nonisolated",
  "open",
  "package",
  "private",
  "public",
]);

function skipWhitespace(source: string, start: number): number {
  let cursor = start;
  while (/\s/.test(source[cursor] ?? "")) cursor++;
  return cursor;
}

function mainTypeBodies(source: string): SourceBodyRange[] {
  const bodies: SourceBodyRange[] = [];
  const mainPattern = /@main\b/g;
  let mainMatch: RegExpExecArray | null;

  while ((mainMatch = mainPattern.exec(source)) !== null) {
    let cursor = mainMatch.index + mainMatch[0].length;

    // Other declaration attributes and access modifiers may appear between
    // @main and the type declaration. Anything else makes the proof fail
    // closed rather than guessing which declaration owns the attribute.
    while (true) {
      cursor = skipWhitespace(source, cursor);
      const attribute = /^@[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(
        source.slice(cursor),
      );
      if (attribute) {
        cursor += attribute[0].length;
        const attributeArguments = skipWhitespace(source, cursor);
        if (source[attributeArguments] === "(") {
          const closingParenthesis = matchingParenthesis(source, attributeArguments);
          if (closingParenthesis == null) break;
          cursor = closingParenthesis + 1;
        }
        continue;
      }

      const modifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(cursor))?.[0];
      if (modifier && TYPE_DECLARATION_MODIFIERS.has(modifier)) {
        cursor += modifier.length;
        if (modifier === "nonisolated") {
          const modifierArguments = skipWhitespace(source, cursor);
          if (source[modifierArguments] === "(") {
            const closingParenthesis = matchingParenthesis(source, modifierArguments);
            if (closingParenthesis == null) break;
            cursor = closingParenthesis + 1;
          }
        }
        continue;
      }
      break;
    }

    cursor = skipWhitespace(source, cursor);
    const declaration = /^(?:struct|class|enum|actor)\s+[A-Za-z_][A-Za-z0-9_]*/.exec(
      source.slice(cursor),
    );
    if (!declaration) continue;

    const headerEnd = cursor + declaration[0].length;
    const openingBrace = source.indexOf("{", headerEnd);
    if (openingBrace === -1) continue;
    const headerRemainder = source.slice(headerEnd, openingBrace);
    if (/[;}]/.test(headerRemainder) || /@main\b/.test(headerRemainder)) continue;
    const closingBrace = matchingBrace(source, openingBrace);
    if (closingBrace == null) continue;
    bodies.push({ openingBrace, closingBrace });
    mainPattern.lastIndex = closingBrace + 1;
  }

  return bodies;
}

function braceDepthAt(source: string, openingBrace: number, position: number): number {
  let depth = 0;
  for (let index = openingBrace; index < position; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}") depth--;
  }
  return depth;
}

function isInsideConditionalCompilation(source: string, position: number): boolean {
  const directive = /^[\t ]*#(if|elseif|else|endif)\b/gm;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = directive.exec(source)) !== null && match.index < position) {
    if (match[1] === "if") depth++;
    if (match[1] === "endif") depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

function mainInitializerBodies(source: string): SourceBodyRange[] {
  const mainTypes = mainTypeBodies(source);
  // Multiple @main declarations in one file are ambiguous even though the
  // file-level entry-point evidence has only one path.
  if (mainTypes.length !== 1) return [];

  const typeBody = mainTypes[0];
  if (!typeBody) return [];
  const initializers: SourceBodyRange[] = [];
  const initializerPattern = /\binit\s*([?!])?\s*\(/g;
  initializerPattern.lastIndex = typeBody.openingBrace + 1;
  let match: RegExpExecArray | null;

  while (
    (match = initializerPattern.exec(source)) !== null &&
    match.index < typeBody.closingBrace
  ) {
    if (
      match[1] != null ||
      braceDepthAt(source, typeBody.openingBrace, match.index) !== 1 ||
      isInsideConditionalCompilation(source, match.index)
    ) {
      continue;
    }

    const openingParenthesis = source.indexOf("(", match.index);
    const closingParenthesis = matchingParenthesis(source, openingParenthesis);
    if (closingParenthesis == null || closingParenthesis >= typeBody.closingBrace) continue;
    if (source.slice(openingParenthesis + 1, closingParenthesis).trim() !== "") continue;

    const openingBrace = skipWhitespace(source, closingParenthesis + 1);
    if (source[openingBrace] !== "{") continue;
    const closingBrace = matchingBrace(source, openingBrace);
    if (closingBrace == null || closingBrace > typeBody.closingBrace) continue;
    initializers.push({ openingBrace, closingBrace });
    initializerPattern.lastIndex = closingBrace + 1;
  }

  return initializers;
}

function isDirectStatementInMainInitializer(
  source: string,
  callIndex: number,
  initializerBodies: SourceBodyRange[],
): boolean {
  const initializer = initializerBodies.find(
    (body) => callIndex > body.openingBrace && callIndex < body.closingBrace,
  );
  if (!initializer) return false;
  if (braceDepthAt(source, initializer.openingBrace, callIndex) !== 1) return false;
  if (isInsideConditionalCompilation(source, callIndex)) return false;

  let cursor = callIndex - 1;
  while (source[cursor] === " " || source[cursor] === "\t") cursor--;
  return (
    cursor === initializer.openingBrace ||
    source[cursor] === "\n" ||
    source[cursor] === "\r" ||
    source[cursor] === ";" ||
    source[cursor] === "}"
  );
}

function publishableKeyWiring(
  sanitizedCallBody: string,
  originalCallBody: string,
): {
  wiring: IOSPublishableKeyWiring;
  inlinePublishableKey?: IOSInlinePublishableKeyInspection;
} {
  const label = /\bpublishableKey\s*:/.exec(sanitizedCallBody);
  if (!label) return { wiring: "custom" };
  const expressionStart = label.index + label[0].length;
  let expressionEnd = sanitizedCallBody.length;
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let index = expressionStart; index < sanitizedCallBody.length; index++) {
    const character = sanitizedCallBody[index];
    if (character === "(") parenthesisDepth++;
    if (character === ")") parenthesisDepth--;
    if (character === "[") bracketDepth++;
    if (character === "]") bracketDepth--;
    if (character === "{") braceDepth++;
    if (character === "}") braceDepth--;
    if (character === "," && parenthesisDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      expressionEnd = index;
      break;
    }
  }
  const expression = sanitizedCallBody.slice(expressionStart, expressionEnd);
  const originalExpression = originalCallBody.slice(expressionStart, expressionEnd);

  // A direct ordinary string literal is the documented native iOS setup. Only
  // retain decoded, non-secret metadata; the literal itself must never enter
  // inspection, JSON, diagnostics, or telemetry.
  const inlineLiteral = /^\s*"([^"\\]*)"\s*$/.exec(originalExpression);
  if (inlineLiteral?.[1] != null && expression.trim() === "") {
    try {
      const decoded = decodePublishableKey(inlineLiteral[1]);
      return {
        wiring: "inline-literal",
        inlinePublishableKey: {
          state: "valid",
          frontendApiHost: decoded.fapiHost,
          instanceType: decoded.instanceType,
        },
      };
    } catch {
      return {
        wiring: "inline-literal",
        inlinePublishableKey: { state: "invalid" },
      };
    }
  }

  return { wiring: "custom" };
}

function configureCallEvidence(
  sanitizedSource: string,
  originalSource: string,
  evidence: IOSSourceEvidence,
): IOSConfigureCallEvidence[] {
  const calls: IOSConfigureCallEvidence[] = [];
  const initializerBodies = mainInitializerBodies(sanitizedSource);
  const pattern = new RegExp(CLERK_CONFIGURE_CALL.source, "g");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(sanitizedSource)) !== null) {
    const openingParenthesis = sanitizedSource.indexOf("(", match.index);
    const closingParenthesis = matchingParenthesis(sanitizedSource, openingParenthesis);
    if (closingParenthesis == null) {
      calls.push({
        ...evidence,
        publishableKeyWiring: "custom",
        startupBinding: isDirectStatementInMainInitializer(
          sanitizedSource,
          match.index,
          initializerBodies,
        )
          ? "app-init"
          : "unproven",
      });
      break;
    }
    const classification = publishableKeyWiring(
      sanitizedSource.slice(openingParenthesis + 1, closingParenthesis),
      originalSource.slice(openingParenthesis + 1, closingParenthesis),
    );
    calls.push({
      ...evidence,
      publishableKeyWiring: classification.wiring,
      inlinePublishableKey: classification.inlinePublishableKey,
      startupBinding: isDirectStatementInMainInitializer(
        sanitizedSource,
        match.index,
        initializerBodies,
      )
        ? "app-init"
        : "unproven",
    });
    pattern.lastIndex = closingParenthesis + 1;
  }

  return calls;
}

function withoutPreviewOnlyRegions(source: string): string {
  const chars = source.split("");
  const patterns = [/#Preview\b/g, /\bstruct\s+\w+[^{}]*:\s*[^{}]*\bPreviewProvider\b/g];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const openingBrace = source.indexOf("{", match.index + match[0].length);
      if (openingBrace === -1) continue;
      const closingBrace = matchingBrace(source, openingBrace);
      if (closingBrace == null) continue;
      blankRange(chars, match.index, closingBrace + 1);
    }
  }
  return chars.join("");
}

type SwiftTargetPlatform = "ios" | "macos";

type PlatformCondition = boolean | "unknown";
type ConditionalExecution = "active" | "inactive" | "unknown";

interface ConditionalCompilationFrame {
  parentExecution: ConditionalExecution;
  priorCondition: PlatformCondition;
  sawElse: boolean;
}

interface PlatformSourceSanitization extends SwiftSourceSanitization {
  uncertainSource: string;
}

function evaluatePlatformCondition(
  expression: string,
  platform: SwiftTargetPlatform,
): PlatformCondition {
  const normalized = expression.trim();
  const osMatch = /^os\s*\(\s*(iOS|macOS)\s*\)$/.exec(normalized);
  if (osMatch) return osMatch[1] === (platform === "ios" ? "iOS" : "macOS");

  const importMatch = /^canImport\s*\(\s*(UIKit|AppKit)\s*\)$/.exec(normalized);
  if (importMatch) return importMatch[1] === (platform === "ios" ? "UIKit" : "AppKit");

  return "unknown";
}

function executionForCondition(
  parent: ConditionalExecution,
  condition: PlatformCondition,
): ConditionalExecution {
  if (parent === "inactive" || condition === false) return "inactive";
  if (parent === "active" && condition === true) return "active";
  return "unknown";
}

function combinedPriorCondition(
  previous: PlatformCondition,
  current: PlatformCondition,
): PlatformCondition {
  if (previous === true || current === true) return true;
  if (previous === "unknown" || current === "unknown") return "unknown";
  return false;
}

/**
 * Keeps only branches proven active for the selected Apple platform. Unknown
 * branches are returned separately so they can invalidate relevant evidence
 * without making unrelated conditional logging block inspection.
 */
function withoutInactivePlatformRegions(
  source: string,
  platform: SwiftTargetPlatform,
): PlatformSourceSanitization {
  const chars = source.split("");
  const uncertainChars = source.split("");
  const stack: ConditionalCompilationFrame[] = [];
  let currentExecution: ConditionalExecution = "active";
  let cursor = 0;
  let complete = true;

  while (cursor < source.length) {
    const newline = source.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? source.length : newline;
    const line = source.slice(cursor, lineEnd);
    const directive = /^[ \t]*#(if|elseif|else|endif)\b(.*)$/.exec(line);

    if (!directive) {
      if (currentExecution !== "active") blankRange(chars, cursor, lineEnd);
      if (currentExecution !== "unknown") blankRange(uncertainChars, cursor, lineEnd);
      cursor = newline === -1 ? source.length : newline + 1;
      continue;
    }

    blankRange(uncertainChars, cursor, lineEnd);

    const kind = directive[1];
    const expression = directive[2]?.trim() ?? "";
    if (kind === "if") {
      if (!expression) {
        complete = false;
        break;
      }
      const condition = evaluatePlatformCondition(expression, platform);
      stack.push({
        parentExecution: currentExecution,
        priorCondition: condition,
        sawElse: false,
      });
      currentExecution = executionForCondition(currentExecution, condition);
    } else if (kind === "elseif") {
      const frame = stack.at(-1);
      if (!frame || frame.sawElse || !expression) {
        complete = false;
        break;
      }
      const condition = evaluatePlatformCondition(expression, platform);
      currentExecution =
        frame.priorCondition === true
          ? "inactive"
          : frame.priorCondition === false
            ? executionForCondition(frame.parentExecution, condition)
            : condition === false || frame.parentExecution === "inactive"
              ? "inactive"
              : "unknown";
      frame.priorCondition = combinedPriorCondition(frame.priorCondition, condition);
    } else if (kind === "else") {
      const frame = stack.at(-1);
      if (!frame || frame.sawElse || expression) {
        complete = false;
        break;
      }
      frame.sawElse = true;
      currentExecution =
        frame.priorCondition === true
          ? "inactive"
          : frame.priorCondition === false
            ? frame.parentExecution
            : frame.parentExecution === "inactive"
              ? "inactive"
              : "unknown";
      frame.priorCondition = true;
    } else {
      const frame = stack.pop();
      if (!frame || expression) {
        complete = false;
        break;
      }
      currentExecution = frame.parentExecution;
    }

    // Keep directive lines intact. Besides preserving offsets, this lets
    // mutation planners recognize that an entry point is conditionally built.
    cursor = newline === -1 ? source.length : newline + 1;
  }

  if (stack.length > 0) complete = false;
  if (!complete) {
    blankRange(chars, 0, chars.length);
    blankRange(uncertainChars, 0, uncertainChars.length);
  }
  return {
    sanitizedSource: chars.join(""),
    uncertainSource: uncertainChars.join(""),
    complete,
  };
}

const CONDITIONAL_SETUP_EVIDENCE = [
  /@main\b/,
  CLERK_KIT_IMPORT,
  CLERK_KIT_UI_IMPORT,
  /\bUserButton\s*\(/,
  ...CLERK_EVIDENCE_PATTERNS,
];

function hasConditionalSetupEvidence(source: string, importsClerkModule: boolean): boolean {
  if (CONDITIONAL_SETUP_EVIDENCE.some((pattern) => has(source, pattern))) return true;
  return (
    importsClerkModule &&
    has(source, /\.\s*auth\s*\.\s*(?:signIn(?:With\w+)?|signUp(?:With\w+)?|startHostedAuth)\s*\(/)
  );
}

function hasClerkOpenURLHandler(source: string): boolean {
  const pattern = /\.\s*onOpenURL\b/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    let cursor = match.index + match[0].length;
    while (/\s/.test(source[cursor] ?? "")) cursor++;

    let openingBrace: number | undefined;
    if (source[cursor] === "{") {
      openingBrace = cursor;
    } else if (source[cursor] === "(") {
      const closingParenthesis = source.indexOf(")", cursor + 1);
      const candidateBrace = source.indexOf("{", cursor + 1);
      if (
        candidateBrace !== -1 &&
        (closingParenthesis === -1 || candidateBrace < closingParenthesis)
      ) {
        openingBrace = candidateBrace;
      }
    }

    if (openingBrace == null) continue;
    const closingBrace = matchingBrace(source, openingBrace);
    if (closingBrace == null) continue;
    if (has(source.slice(openingBrace + 1, closingBrace), CLERK_URL_HANDLER)) return true;
    pattern.lastIndex = closingBrace + 1;
  }

  return false;
}

export async function inspectSwiftSources(
  sourceFiles: Array<{ absolutePath: string; relativePath: string }>,
  options: { membershipComplete?: boolean; platform?: SwiftTargetPlatform } = {},
): Promise<IOSSwiftInspection> {
  const entryPoints: IOSSourceEvidence[] = [];
  const importsClerkKit: IOSSourceEvidence[] = [];
  const importsClerkKitUI: IOSSourceEvidence[] = [];
  const configureCalls: IOSConfigureCallEvidence[] = [];
  const environmentInjections: IOSSourceEvidence[] = [];
  const environmentConsumers: IOSSourceEvidence[] = [];
  const authFlowReferences: IOSSourceEvidence[] = [];
  const openURLHandlers: IOSSourceEvidence[] = [];
  let sourceFilesScanned = 0;
  let evidenceComplete = options.membershipComplete ?? true;

  for (const file of sourceFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const diskFile = Bun.file(file.absolutePath);
    if (!(await diskFile.exists()) || diskFile.size > MAX_SWIFT_FILE_BYTES) {
      evidenceComplete = false;
      continue;
    }

    let source: string;
    try {
      source = await readFile(file.absolutePath, "utf8");
    } catch {
      evidenceComplete = false;
      continue;
    }

    sourceFilesScanned++;
    const structuralSource = sanitizeSwiftSourceWithStatus(source);
    if (!structuralSource.complete) evidenceComplete = false;
    const platformSource = options.platform
      ? withoutInactivePlatformRegions(structuralSource.sanitizedSource, options.platform)
      : undefined;
    if (platformSource && !platformSource.complete) evidenceComplete = false;
    const sanitized = withoutPreviewOnlyRegions(
      platformSource?.sanitizedSource ?? structuralSource.sanitizedSource,
    );
    const uncertain = platformSource
      ? withoutPreviewOnlyRegions(platformSource.uncertainSource)
      : "";
    const evidence = { path: file.relativePath };
    const importsKit = has(sanitized, CLERK_KIT_IMPORT);
    const importsUI = has(sanitized, CLERK_KIT_UI_IMPORT);
    const importsClerkModule = importsKit || importsUI;
    if (hasConditionalSetupEvidence(uncertain, importsClerkModule)) evidenceComplete = false;

    if (has(sanitized, /@main\b/)) entryPoints.push(evidence);
    if (importsKit) importsClerkKit.push(evidence);
    if (importsUI) importsClerkKitUI.push(evidence);
    if (importsClerkModule) {
      configureCalls.push(...configureCallEvidence(sanitized, source, evidence));
    }
    if (importsClerkModule && has(sanitized, CLERK_ENVIRONMENT_INJECTION)) {
      environmentInjections.push(evidence);
    }
    if (importsClerkModule && has(sanitized, CLERK_ENVIRONMENT_CONSUMER)) {
      environmentConsumers.push(evidence);
    }
    if (
      (importsUI && has(sanitized, CLERK_AUTH_VIEW)) ||
      (importsClerkModule && has(sanitized, CLERK_NATIVE_AUTH_FLOW))
    ) {
      authFlowReferences.push(evidence);
    }
    if (importsClerkModule && hasClerkOpenURLHandler(sanitized)) {
      openURLHandlers.push(evidence);
    }
  }

  const anyClerkEvidence =
    importsClerkKit.length +
      importsClerkKitUI.length +
      configureCalls.length +
      environmentInjections.length +
      environmentConsumers.length +
      authFlowReferences.length >
    0;
  const status =
    entryPoints.length > 1
      ? "ambiguous"
      : configureCalls.length > 0 && environmentInjections.length > 0
        ? "complete"
        : anyClerkEvidence
          ? "partial"
          : "absent";

  return {
    sourceFilesScanned,
    evidenceComplete,
    entryPoints,
    importsClerkKit,
    importsClerkKitUI,
    configureCalls,
    environmentInjections,
    environmentConsumers,
    authFlowReferences,
    openURLHandlers,
    status,
  };
}
