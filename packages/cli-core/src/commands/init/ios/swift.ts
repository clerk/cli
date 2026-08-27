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
          i += 2 + escapeHashes;
          continue;
        }
      }
      i++;
    }

    if (!closed) complete = false;
    if (blankStrings) blankRange(chars, start, i);
  }

  return { sanitizedSource: chars.join(""), complete };
}

export function sanitizeSwiftSource(source: string): string {
  return sanitizeSwiftSourceWithStatus(source).sanitizedSource;
}

export function sanitizeSwiftSourceWithStatus(source: string): SwiftSourceSanitization {
  return sanitizeSwift(source, true);
}

function sourceWithoutComments(source: string): SwiftSourceSanitization {
  return sanitizeSwift(source, false);
}

function has(source: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  return pattern.test(source);
}

const CLERK_URL_HANDLER = /\b(?:Clerk\s*\.\s*shared|clerk)\s*\.\s*handle\s*\(/;
const CLERK_NATIVE_AUTH_FLOW =
  /\b(?:Clerk\s*\.\s*shared|clerk)\s*\.\s*auth\s*\.\s*(?:signIn(?:With(?:Password|EmailCode|EmailLink|PhoneCode|OAuth|IdToken|Apple|Passkey|EnterpriseSSO|Ticket))?|signUp(?:With(?:OAuth|Apple|IdToken|EnterpriseSSO|Ticket))?|startHostedAuth)\s*\(/;

function topLevelCommaSeparated(source: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "(") parenthesisDepth++;
    if (character === ")") parenthesisDepth--;
    if (character === "[") bracketDepth++;
    if (character === "]") bracketDepth--;
    if (character === "{") braceDepth++;
    if (character === "}") braceDepth--;
    if (character === "," && parenthesisDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      segments.push(source.slice(start, index));
      start = index + 1;
    }
  }
  segments.push(source.slice(start));
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

interface DirectStaticMethodEvidence {
  name: string;
  parameters: string;
  header: string;
  openingBrace: number;
  closingBrace: number;
}

interface BundleParameterEvidence {
  externalName: string;
  localName: string;
  defaultsToMain: boolean;
}

function directStaticMethods(
  source: string,
  typeOpeningBrace: number,
  typeClosingBrace: number,
): DirectStaticMethodEvidence[] {
  const methods: DirectStaticMethodEvidence[] = [];
  const methodPattern = /\bstatic\s+func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  methodPattern.lastIndex = typeOpeningBrace + 1;
  let method: RegExpExecArray | null;

  while ((method = methodPattern.exec(source)) !== null && method.index < typeClosingBrace) {
    const name = method[1];
    if (!name || braceDepthAt(source, typeOpeningBrace, method.index) !== 1) continue;
    const openingParenthesis = source.indexOf("(", method.index);
    const closingParenthesis = matchingParenthesis(source, openingParenthesis);
    if (closingParenthesis == null || closingParenthesis >= typeClosingBrace) continue;
    const parameters = source.slice(openingParenthesis + 1, closingParenthesis);

    const methodOpeningBrace = source.indexOf("{", closingParenthesis + 1);
    if (methodOpeningBrace === -1 || methodOpeningBrace >= typeClosingBrace) continue;
    const methodHeader = source.slice(closingParenthesis + 1, methodOpeningBrace);
    if (
      /[;}]/.test(methodHeader) ||
      /\bfunc\b/.test(methodHeader) ||
      braceDepthAt(source, typeOpeningBrace, methodOpeningBrace) !== 1
    ) {
      continue;
    }
    const methodClosingBrace = matchingBrace(source, methodOpeningBrace);
    if (methodClosingBrace == null || methodClosingBrace > typeClosingBrace) continue;

    methods.push({
      name,
      parameters,
      header: methodHeader,
      openingBrace: methodOpeningBrace,
      closingBrace: methodClosingBrace,
    });
    methodPattern.lastIndex = methodClosingBrace + 1;
  }

  return methods;
}

function bundleParameters(parameters: string): BundleParameterEvidence[] {
  return topLevelCommaSeparated(parameters).flatMap((parameter) => {
    const match =
      /^(?:(_|[A-Za-z_][A-Za-z0-9_]*)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*Bundle\b([\s\S]*)$/.exec(
        parameter,
      );
    const localName = match?.[2];
    if (!localName) return [];
    return [
      {
        externalName: match[1] ?? localName,
        localName,
        defaultsToMain: /=\s*(?:Bundle\s*)?\.\s*main\b/.test(match[3] ?? ""),
      },
    ];
  });
}

function directZeroArgumentLoadEvidence(
  methods: DirectStaticMethodEvidence[],
): DirectStaticMethodEvidence | undefined {
  const candidates = methods.filter((method) => {
    if (method.name !== "load" || /\b(?:async|throws|rethrows)\b/.test(method.header)) {
      return false;
    }
    return topLevelCommaSeparated(method.parameters).every((parameter) => parameter.includes("="));
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function directCallArguments(
  source: string,
  caller: DirectStaticMethodEvidence,
  typeSymbol: string,
  calleeName: string,
): string[] {
  const bodyStart = caller.openingBrace + 1;
  const body = source.slice(bodyStart, caller.closingBrace);
  const escapedType = escapeRegularExpression(typeSymbol);
  const escapedCallee = escapeRegularExpression(calleeName);
  const pattern = new RegExp(
    `(?:^|[^A-Za-z0-9_.])(?:(?:Self|${escapedType})\\s*\\.\\s*)?${escapedCallee}\\s*\\(`,
    "g",
  );
  const argumentsList: string[] = [];
  let call: RegExpExecArray | null;

  while ((call = pattern.exec(body)) !== null) {
    const localOpeningParenthesis = call.index + call[0].lastIndexOf("(");
    const openingParenthesis = bodyStart + localOpeningParenthesis;
    if (braceDepthAt(source, caller.openingBrace, openingParenthesis) !== 1) continue;
    const closingParenthesis = matchingParenthesis(source, openingParenthesis);
    if (closingParenthesis == null || closingParenthesis >= caller.closingBrace) continue;
    argumentsList.push(source.slice(openingParenthesis + 1, closingParenthesis));
    pattern.lastIndex = closingParenthesis - bodyStart + 1;
  }

  return argumentsList;
}

function reachableStaticMethods(
  source: string,
  typeSymbol: string,
  methods: DirectStaticMethodEvidence[],
  root: DirectStaticMethodEvidence,
): DirectStaticMethodEvidence[] | undefined {
  const methodsByName = new Map<string, DirectStaticMethodEvidence[]>();
  for (const method of methods) {
    const existing = methodsByName.get(method.name) ?? [];
    existing.push(method);
    methodsByName.set(method.name, existing);
  }

  const reachable = new Map<number, DirectStaticMethodEvidence>([[root.openingBrace, root]]);
  const pending = [root];
  while (pending.length > 0) {
    const caller = pending.shift();
    if (!caller) break;
    const callerBody = source.slice(caller.openingBrace + 1, caller.closingBrace);
    for (const [name, candidates] of methodsByName) {
      const calls = directCallArguments(source, caller, typeSymbol, name);
      if (calls.length === 0) continue;
      if (
        new RegExp(`\\b(?:let|var|func)\\s+${escapeRegularExpression(name)}\\b`).test(callerBody)
      ) {
        return undefined;
      }
      if (candidates.length !== 1) return undefined;
      const callee = candidates[0];
      if (callee && !reachable.has(callee.openingBrace)) {
        reachable.set(callee.openingBrace, callee);
        pending.push(callee);
      }
    }
  }
  return [...reachable.values()];
}

function localDeclarationPositions(
  source: string,
  method: DirectStaticMethodEvidence,
  name: string,
): number[] {
  const bodyStart = method.openingBrace + 1;
  const body = source.slice(bodyStart, method.closingBrace);
  const pattern = new RegExp(`\\b(?:let|var)\\s+${escapeRegularExpression(name)}\\b`, "g");
  return [...body.matchAll(pattern)].map((match) => bodyStart + match.index);
}

function hasUniqueDirectImmutableLocalDeclaration(
  source: string,
  method: DirectStaticMethodEvidence,
  name: string,
): boolean {
  const bodyStart = method.openingBrace + 1;
  const body = source.slice(bodyStart, method.closingBrace);
  const declarationPattern = new RegExp(`\\b(let|var)\\s+${escapeRegularExpression(name)}\\b`, "g");
  const declarations = [...body.matchAll(declarationPattern)];
  return (
    declarations.length === 1 &&
    declarations[0]?.[1] === "let" &&
    declarations[0].index != null &&
    braceDepthAt(source, method.openingBrace, bodyStart + declarations[0].index) === 1
  );
}

function hasUniqueImmutableInitializedLocal(
  source: string,
  method: DirectStaticMethodEvidence,
  name: string,
): boolean {
  if (!hasUniqueDirectImmutableLocalDeclaration(source, method, name)) return false;
  const body = source.slice(method.openingBrace + 1, method.closingBrace);
  const escapedName = escapeRegularExpression(name);
  const declarationsWithInitializers = [
    ...body.matchAll(new RegExp(`\\blet\\s+${escapedName}(?:\\s*:[^=,;{}\\n\\r]+)?\\s*=`, "g")),
  ];
  if (declarationsWithInitializers.length !== 1) return false;

  // An immutable declaration may only receive its declaration initializer.
  // Property/subscript writes and mutating collection operations make the
  // value reaching the key lookup impossible to prove with this scanner.
  const writes = [
    ...body.matchAll(
      new RegExp(
        `\\b${escapedName}\\s*(?:\\[[^\\]\\n\\r]*\\]|\\.[A-Za-z_][A-Za-z0-9_]*)?\\s*=(?!=)`,
        "g",
      ),
    ),
  ];
  if (writes.length !== 1) return false;
  return !new RegExp(
    `\\b${escapedName}\\s*\\.\\s*(?:append|appendContentsOf|insert|remove|removeAll|removeValue|replaceSubrange|reserveCapacity|sort|swapAt|updateValue)\\s*\\(`,
  ).test(body);
}

function hasParameterMutationOrShadowing(
  source: string,
  method: DirectStaticMethodEvidence,
  parameter: string,
): boolean {
  if (localDeclarationPositions(source, method, parameter).length > 0) return true;
  const body = source.slice(method.openingBrace + 1, method.closingBrace);
  const escapedParameter = escapeRegularExpression(parameter);
  return (
    new RegExp(
      `\\b${escapedParameter}\\s*(?:\\[[^\\]\\n\\r]*\\]|\\.[A-Za-z_][A-Za-z0-9_]*)?\\s*=(?!=)`,
    ).test(body) ||
    new RegExp(
      `\\b${escapedParameter}\\s*\\.\\s*(?:append|appendContentsOf|insert|remove|removeAll|removeValue|replaceSubrange|reserveCapacity|sort|swapAt|updateValue)\\s*\\(`,
    ).test(body)
  );
}

interface ExactMainBundleResourceEvidence {
  urlVariablesByMethod: Map<number, Set<string>>;
}

function exactMainBundleResourceEvidence(
  structuralSource: string,
  valueSource: string,
  typeSymbol: string,
  reachableMethods: DirectStaticMethodEvidence[],
  loadMethod: DirectStaticMethodEvidence,
): ExactMainBundleResourceEvidence {
  const trustedBundleParameters = new Map<number, Set<string>>([
    [
      loadMethod.openingBrace,
      new Set(
        bundleParameters(loadMethod.parameters)
          .filter((parameter) => parameter.defaultsToMain)
          .map((parameter) => parameter.localName),
      ),
    ],
  ]);
  const methodsByName = new Map(reachableMethods.map((method) => [method.name, method]));

  let changed = true;
  while (changed) {
    changed = false;
    for (const caller of reachableMethods) {
      const trustedCallerNames = new Set(
        [...(trustedBundleParameters.get(caller.openingBrace) ?? [])].filter(
          (name) => localDeclarationPositions(structuralSource, caller, name).length === 0,
        ),
      );
      for (const [calleeName, callee] of methodsByName) {
        const calleeBundleParameters = bundleParameters(callee.parameters);
        if (calleeBundleParameters.length === 0) continue;
        for (const callArguments of directCallArguments(
          structuralSource,
          caller,
          typeSymbol,
          calleeName,
        )) {
          const argumentSegments = topLevelCommaSeparated(callArguments);
          for (const parameter of calleeBundleParameters) {
            if (parameter.externalName === "_") continue;
            const escapedLabel = escapeRegularExpression(parameter.externalName);
            const trustedArgument = argumentSegments.some((argument) => {
              const label = new RegExp(`^${escapedLabel}\\s*:\\s*([A-Za-z_][A-Za-z0-9_]*)$`).exec(
                argument,
              );
              return label?.[1] != null && trustedCallerNames.has(label[1]);
            });
            const literalMainArgument = argumentSegments.some((argument) =>
              new RegExp(`^${escapedLabel}\\s*:\\s*(?:Bundle\\s*)?\\.\\s*main$`).test(argument),
            );
            if (!trustedArgument && !literalMainArgument) continue;
            const trustedCalleeNames =
              trustedBundleParameters.get(callee.openingBrace) ?? new Set<string>();
            if (!trustedCalleeNames.has(parameter.localName)) {
              trustedCalleeNames.add(parameter.localName);
              trustedBundleParameters.set(callee.openingBrace, trustedCalleeNames);
              changed = true;
            }
          }
        }
      }
    }
  }

  const urlVariablesByMethod = new Map<number, Set<string>>();
  for (const method of reachableMethods) {
    const body = valueSource.slice(method.openingBrace + 1, method.closingBrace);
    const urlVariables = new Set<string>();
    for (const match of body.matchAll(
      /\blet\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*Bundle\s*\.\s*main\s*\.\s*url\s*\(\s*forResource\s*:\s*"LocalSecrets"\s*,\s*withExtension\s*:\s*"plist"/g,
    )) {
      if (match[1] && hasUniqueImmutableInitializedLocal(structuralSource, method, match[1])) {
        urlVariables.add(match[1]);
      }
    }
    for (const variable of trustedBundleParameters.get(method.openingBrace) ?? []) {
      if (localDeclarationPositions(structuralSource, method, variable).length > 0) continue;
      const pattern = new RegExp(
        `\\blet\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*${escapeRegularExpression(variable)}\\s*\\.\\s*url\\s*\\(\\s*forResource\\s*:\\s*"LocalSecrets"\\s*,\\s*withExtension\\s*:\\s*"plist"`,
        "g",
      );
      for (const match of body.matchAll(pattern)) {
        if (match[1] && hasUniqueImmutableInitializedLocal(structuralSource, method, match[1])) {
          urlVariables.add(match[1]);
        }
      }
    }
    if (urlVariables.size > 0) urlVariablesByMethod.set(method.openingBrace, urlVariables);
  }
  return { urlVariablesByMethod };
}

interface RedactedExpressionEvidence {
  structural: string;
  value: string;
}

interface NamedParameterEvidence {
  externalName: string;
  localName: string;
}

function namedParameters(parameters: string): NamedParameterEvidence[] {
  return topLevelCommaSeparated(parameters).flatMap((parameter) => {
    const match = /^(?:(_|[A-Za-z_][A-Za-z0-9_]*)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(parameter);
    const localName = match?.[2];
    if (!localName) return [];
    return [{ externalName: match[1] ?? localName, localName }];
  });
}

function isTopLevelPosition(source: string, position: number): boolean {
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let index = 0; index < position; index++) {
    const character = source[index];
    if (character === "(") parenthesisDepth++;
    if (character === ")") parenthesisDepth--;
    if (character === "[") bracketDepth++;
    if (character === "]") bracketDepth--;
    if (character === "{") braceDepth++;
    if (character === "}") braceDepth--;
  }
  return parenthesisDepth === 0 && bracketDepth === 0 && braceDepth === 0;
}

function topLevelLabeledExpression(
  structuralArguments: string,
  valueArguments: string,
  label: string,
): RedactedExpressionEvidence | undefined {
  const labelPattern = new RegExp(`\\b${escapeRegularExpression(label)}\\s*:`, "g");
  const expressions: RedactedExpressionEvidence[] = [];
  let match: RegExpExecArray | null;

  while ((match = labelPattern.exec(structuralArguments)) !== null) {
    if (!isTopLevelPosition(structuralArguments, match.index)) continue;
    const start = match.index + match[0].length;
    let end = structuralArguments.length;
    let parenthesisDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    for (let index = start; index < structuralArguments.length; index++) {
      const character = structuralArguments[index];
      if (character === "(") parenthesisDepth++;
      if (character === ")") parenthesisDepth--;
      if (character === "[") bracketDepth++;
      if (character === "]") bracketDepth--;
      if (character === "{") braceDepth++;
      if (character === "}") braceDepth--;
      if (character === "," && parenthesisDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        end = index;
        break;
      }
    }
    expressions.push({
      structural: structuralArguments.slice(start, end),
      value: valueArguments.slice(start, end),
    });
  }

  return expressions.length === 1 ? expressions[0] : undefined;
}

function returnedPublishableKeyExpression(
  structuralSource: string,
  valueSource: string,
  typeSymbol: string,
  loadMethod: DirectStaticMethodEvidence,
): RedactedExpressionEvidence | undefined {
  const bodyStart = loadMethod.openingBrace + 1;
  const structuralBody = structuralSource.slice(bodyStart, loadMethod.closingBrace);
  const escapedType = escapeRegularExpression(typeSymbol);
  const returnPattern = new RegExp(`\\breturn\\s+(?:\\.\\s*init|${escapedType})\\s*\\(`, "g");
  const expressions: RedactedExpressionEvidence[] = [];
  let returnedInitializer: RegExpExecArray | null;

  while ((returnedInitializer = returnPattern.exec(structuralBody)) !== null) {
    const returnIndex = bodyStart + returnedInitializer.index;
    if (braceDepthAt(structuralSource, loadMethod.openingBrace, returnIndex) !== 1) continue;
    const openingParenthesis =
      bodyStart + returnedInitializer.index + returnedInitializer[0].lastIndexOf("(");
    const closingParenthesis = matchingParenthesis(structuralSource, openingParenthesis);
    if (closingParenthesis == null || closingParenthesis >= loadMethod.closingBrace) continue;
    const structuralArguments = structuralSource.slice(openingParenthesis + 1, closingParenthesis);
    const valueArguments = valueSource.slice(openingParenthesis + 1, closingParenthesis);
    const expression = topLevelLabeledExpression(
      structuralArguments,
      valueArguments,
      "publishableKey",
    );
    if (expression) expressions.push(expression);
    returnPattern.lastIndex = closingParenthesis - bodyStart + 1;
  }

  return expressions.length === 1 ? expressions[0] : undefined;
}

function correlatedDecodedDictionaryNames(
  structuralSource: string,
  valueSource: string,
  method: DirectStaticMethodEvidence,
  exactURLVariables: Set<string>,
): Set<string> {
  const body = valueSource.slice(method.openingBrace + 1, method.closingBrace);
  const dataVariables = new Set<string>();
  for (const urlVariable of exactURLVariables) {
    const pattern = new RegExp(
      `\\blet\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(?:try\\s*[?!]?\\s*)?Data\\s*\\(\\s*contentsOf\\s*:\\s*${escapeRegularExpression(urlVariable)}\\b`,
      "g",
    );
    for (const match of body.matchAll(pattern)) {
      if (match[1] && hasUniqueImmutableInitializedLocal(structuralSource, method, match[1])) {
        dataVariables.add(match[1]);
      }
    }
  }

  const propertyListVariables = new Set<string>();
  for (const dataVariable of dataVariables) {
    const pattern = new RegExp(
      `\\blet\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(?:try\\s*[?!]?\\s*)?PropertyListSerialization\\s*\\.\\s*propertyList\\s*\\(\\s*from\\s*:\\s*${escapeRegularExpression(dataVariable)}\\b`,
      "g",
    );
    for (const match of body.matchAll(pattern)) {
      if (match[1] && hasUniqueImmutableInitializedLocal(structuralSource, method, match[1])) {
        propertyListVariables.add(match[1]);
      }
    }
  }

  const dictionaryVariables = new Set<string>();
  for (const propertyListVariable of propertyListVariables) {
    const pattern = new RegExp(
      `\\blet\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*${escapeRegularExpression(propertyListVariable)}\\s+as\\s*\\?\\s*\\[\\s*String\\s*:\\s*Any\\s*\\]`,
      "g",
    );
    for (const match of body.matchAll(pattern)) {
      if (match[1] && hasUniqueImmutableInitializedLocal(structuralSource, method, match[1])) {
        dictionaryVariables.add(match[1]);
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const sourceVariable of dictionaryVariables) {
      const aliasPattern = new RegExp(
        `(?:^|[;{}\\n\\r])\\s*let\\s+([A-Za-z_][A-Za-z0-9_]*)(?:\\s*:\\s*[^=;{}\\n\\r]+)?\\s*=\\s*${escapeRegularExpression(sourceVariable)}\\b`,
        "g",
      );
      for (const match of body.matchAll(aliasPattern)) {
        const alias = match[1];
        if (
          alias &&
          !dictionaryVariables.has(alias) &&
          hasUniqueImmutableInitializedLocal(structuralSource, method, alias)
        ) {
          dictionaryVariables.add(alias);
          changed = true;
        }
      }

      // Support the direct fixture's definite-initialization form:
      // `let values: [String: Any]`, assigned either the decoded immutable
      // dictionary or `[:]` in an exact if/else. These are initializations of
      // a `let`, not later mutations.
      const conditionalAliasPattern =
        /\blet\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\[\s*String\s*:\s*Any\s*\](?!\s*=)/g;
      for (const aliasDeclaration of body.matchAll(conditionalAliasPattern)) {
        const alias = aliasDeclaration[1];
        if (
          !alias ||
          alias === sourceVariable ||
          dictionaryVariables.has(alias) ||
          !hasUniqueDirectImmutableLocalDeclaration(structuralSource, method, alias)
        ) {
          continue;
        }
        const escapedAlias = escapeRegularExpression(alias);
        const escapedSource = escapeRegularExpression(sourceVariable);
        const assignments = [
          ...body.matchAll(new RegExp(`\\b${escapedAlias}\\s*=\\s*([^;{}\\n\\r]+)`, "g")),
        ].map((match) => match[1]?.replace(/\s+/g, ""));
        if (
          assignments.length !== 2 ||
          assignments.filter((assignment) => assignment === sourceVariable).length !== 1 ||
          assignments.filter((assignment) => assignment === "[:]").length !== 1 ||
          new RegExp(
            `\\b${escapedAlias}\\s*(?:\\[[^\\]\\n\\r]*\\]|\\.[A-Za-z_][A-Za-z0-9_]*)\\s*=(?!=)`,
          ).test(body) ||
          new RegExp(
            `\\b${escapedAlias}\\s*\\.\\s*(?:append|appendContentsOf|insert|remove|removeAll|removeValue|replaceSubrange|reserveCapacity|sort|swapAt|updateValue)\\s*\\(`,
          ).test(body)
        ) {
          continue;
        }
        const exactBranches = new RegExp(
          `\\{\\s*${escapedAlias}\\s*=\\s*${escapedSource}\\s*\\}\\s*else\\s*\\{\\s*${escapedAlias}\\s*=\\s*\\[\\s*:\\s*\\]\\s*\\}`,
        ).test(body);
        if (!exactBranches) continue;
        dictionaryVariables.add(alias);
        changed = true;
      }
    }
  }
  return dictionaryVariables;
}

function directlyReturnedDictionaryName(
  structuralSource: string,
  method: DirectStaticMethodEvidence,
  dictionaryNames: Set<string>,
): string | undefined {
  const bodyStart = method.openingBrace + 1;
  const body = structuralSource.slice(bodyStart, method.closingBrace);
  const returnedNames: string[] = [];
  const returnPattern = /\breturn\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let returned: RegExpExecArray | null;
  while ((returned = returnPattern.exec(body)) !== null) {
    const name = returned[1];
    const returnIndex = bodyStart + returned.index;
    if (
      name &&
      dictionaryNames.has(name) &&
      braceDepthAt(structuralSource, method.openingBrace, returnIndex) === 1
    ) {
      returnedNames.push(name);
    }
  }
  return returnedNames.length === 1 ? returnedNames[0] : undefined;
}

function directExactKeyLookupBase(valueExpression: string): string | undefined {
  const subscript =
    /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*"CLERK_PUBLISHABLE_KEY"\s*\]\s*(?:as\s*\?\s*String)?\s*$/.exec(
      valueExpression,
    );
  if (subscript?.[1]) return subscript[1];
  return /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(?:value|object)\s*\(\s*forKey\s*:\s*"CLERK_PUBLISHABLE_KEY"\s*\)\s*(?:as\s*\?\s*String)?\s*$/.exec(
    valueExpression,
  )?.[1];
}

interface ReturnStatementEvidence {
  index: number;
  depth: number;
  structuralExpression: string;
  valueExpression: string;
}

function returnStatements(
  structuralSource: string,
  valueSource: string,
  method: DirectStaticMethodEvidence,
): ReturnStatementEvidence[] {
  const bodyStart = method.openingBrace + 1;
  const body = structuralSource.slice(bodyStart, method.closingBrace);
  const statements: ReturnStatementEvidence[] = [];
  const returnPattern = /\breturn\b/g;
  let returned: RegExpExecArray | null;

  while ((returned = returnPattern.exec(body)) !== null) {
    const returnIndex = bodyStart + returned.index;
    let expressionStart = returnIndex + returned[0].length;
    while (
      structuralSource[expressionStart] === " " ||
      structuralSource[expressionStart] === "\t"
    ) {
      expressionStart++;
    }

    let expressionEnd = expressionStart;
    let parenthesisDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    for (; expressionEnd < method.closingBrace; expressionEnd++) {
      const character = structuralSource[expressionEnd];
      if (
        (character === "\n" || character === "\r" || character === ";") &&
        parenthesisDepth === 0 &&
        bracketDepth === 0 &&
        braceDepth === 0
      ) {
        break;
      }
      if (character === "}" && parenthesisDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        break;
      }
      if (character === "(") parenthesisDepth++;
      if (character === ")") parenthesisDepth--;
      if (character === "[") bracketDepth++;
      if (character === "]") bracketDepth--;
      if (character === "{") braceDepth++;
      if (character === "}") braceDepth--;
    }

    statements.push({
      index: returnIndex,
      depth: braceDepthAt(structuralSource, method.openingBrace, returnIndex),
      structuralExpression: structuralSource.slice(expressionStart, expressionEnd).trim(),
      valueExpression: valueSource.slice(expressionStart, expressionEnd).trim(),
    });
    returnPattern.lastIndex = Math.max(returnPattern.lastIndex, expressionEnd - bodyStart);
  }

  return statements;
}

type ExactLookupTransform = "direct" | "normalized";

function exactResolverLookupTransform(
  expression: string,
  plistParameter: string,
  keyParameter: string,
): ExactLookupTransform | undefined {
  const lookup = `${escapeRegularExpression(plistParameter)}\\s*\\[\\s*${escapeRegularExpression(keyParameter)}\\s*\\]\\s*(?:as\\s*\\?\\s*String)?`;
  if (new RegExp(`^${lookup}$`).test(expression)) return "direct";
  if (new RegExp(`^normalized\\s*\\(\\s*${lookup}\\s*\\)$`).test(expression)) {
    return "normalized";
  }
  return undefined;
}

function isCanonicalNormalizer(
  structuralSource: string,
  methods: DirectStaticMethodEvidence[],
): boolean {
  const candidates = methods.filter((method) => method.name === "normalized");
  if (candidates.length !== 1) return false;
  const normalizer = candidates[0];
  if (!normalizer) return false;
  const parameters = topLevelCommaSeparated(normalizer.parameters);
  if (parameters.length !== 1) return false;
  const parameter = /^_\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*String\s*\?$/.exec(parameters[0] ?? "");
  const parameterName = parameter?.[1];
  if (!parameterName || !/^\s*->\s*String\s*\?\s*$/.test(normalizer.header)) return false;

  const body = structuralSource.slice(normalizer.openingBrace + 1, normalizer.closingBrace);
  const escapedParameter = escapeRegularExpression(parameterName);
  const canonicalBody = new RegExp(
    `^\\s*guard\\s+let\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*${escapedParameter}\\s*\\?\\s*\\.\\s*trimmingCharacters\\s*\\(\\s*in\\s*:\\s*\\.\\s*whitespacesAndNewlines\\s*\\)\\s*,\\s*!\\s*\\1\\s*\\.\\s*isEmpty\\s+else\\s*\\{\\s*return\\s+nil\\s*;?\\s*\\}\\s*return\\s+\\1\\s*;?\\s*$`,
  );
  return canonicalBody.test(body);
}

function hasResolverParameterMutation(
  structuralSource: string,
  method: DirectStaticMethodEvidence,
  parameter: string,
): boolean {
  return hasParameterMutationOrShadowing(structuralSource, method, parameter);
}

function isExactEnvironmentOverrideReturn(
  structuralSource: string,
  method: DirectStaticMethodEvidence,
  returned: ReturnStatementEvidence,
  processInfoParameter: string,
  keyParameter: string,
  allowNormalized: boolean,
): boolean {
  const returnedName = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(returned.structuralExpression)?.[1];
  if (!returnedName || returned.depth !== 2) return false;

  const bodyStart = method.openingBrace + 1;
  const body = structuralSource.slice(bodyStart, method.closingBrace);
  const environmentLookup = `${escapeRegularExpression(processInfoParameter)}\\s*\\.\\s*environment\\s*\\[\\s*${escapeRegularExpression(keyParameter)}\\s*\\]`;
  const trustedLookup = allowNormalized
    ? `(?:${environmentLookup}|normalized\\s*\\(\\s*${environmentLookup}\\s*\\))`
    : environmentLookup;
  const pattern = new RegExp(
    `\\bif\\s+let\\s+${escapeRegularExpression(returnedName)}\\s*=\\s*${trustedLookup}\\s*\\{`,
    "g",
  );
  let conditional: RegExpExecArray | null;

  while ((conditional = pattern.exec(body)) !== null) {
    const openingBrace = bodyStart + conditional.index + conditional[0].lastIndexOf("{");
    if (braceDepthAt(structuralSource, method.openingBrace, openingBrace) !== 1) continue;
    const closingBrace = matchingBrace(structuralSource, openingBrace);
    if (
      closingBrace == null ||
      returned.index <= openingBrace ||
      returned.index >= closingBrace ||
      braceDepthAt(structuralSource, openingBrace, returned.index) !== 1
    ) {
      continue;
    }
    const afterConditional = structuralSource.slice(closingBrace + 1, method.closingBrace);
    if (/^\s*else\b/.test(afterConditional)) return false;
    return true;
  }

  return false;
}

function isExactGuardNilReturn(
  structuralSource: string,
  method: DirectStaticMethodEvidence,
  returned: ReturnStatementEvidence,
): boolean {
  if (returned.structuralExpression !== "nil" || returned.depth !== 2) return false;

  const bodyStart = method.openingBrace + 1;
  const body = structuralSource.slice(bodyStart, method.closingBrace);
  const guardPattern = /\bguard\b[^{};]*\belse\s*\{/g;
  let guarded: RegExpExecArray | null;
  while ((guarded = guardPattern.exec(body)) !== null) {
    if (braceDepthAt(structuralSource, method.openingBrace, bodyStart + guarded.index) !== 1) {
      continue;
    }
    const openingBrace = bodyStart + guarded.index + guarded[0].lastIndexOf("{");
    const closingBrace = matchingBrace(structuralSource, openingBrace);
    if (
      closingBrace == null ||
      returned.index <= openingBrace ||
      returned.index >= closingBrace ||
      braceDepthAt(structuralSource, openingBrace, returned.index) !== 1
    ) {
      continue;
    }
    return /^\s*return\s+nil\s*;?\s*$/.test(structuralSource.slice(openingBrace + 1, closingBrace));
  }

  return false;
}

function hasExactDelegatedResolverReturnFlow(
  structuralSource: string,
  valueSource: string,
  resolver: DirectStaticMethodEvidence,
  reachableMethods: DirectStaticMethodEvidence[],
  resolverParameters: NamedParameterEvidence[],
  plistParameter: NamedParameterEvidence,
  keyParameter: NamedParameterEvidence,
): boolean {
  if (
    hasResolverParameterMutation(structuralSource, resolver, plistParameter.localName) ||
    hasResolverParameterMutation(structuralSource, resolver, keyParameter.localName)
  ) {
    return false;
  }

  const statements = returnStatements(structuralSource, valueSource, resolver);
  const directReturns = statements.filter((returned) => returned.depth === 1);
  const directTransform = directReturns[0]
    ? exactResolverLookupTransform(
        directReturns[0].structuralExpression,
        plistParameter.localName,
        keyParameter.localName,
      )
    : undefined;
  if (
    directReturns.length !== 1 ||
    !directTransform ||
    (directTransform === "normalized" && !isCanonicalNormalizer(structuralSource, reachableMethods))
  ) {
    return false;
  }

  const nestedReturns = statements.filter((returned) => returned.depth !== 1);
  if (nestedReturns.length === 0) return true;
  const processInfoParameter = resolverParameters.find(
    (parameter) => parameter.externalName === "processInfo",
  );
  if (
    processInfoParameter &&
    hasResolverParameterMutation(structuralSource, resolver, processInfoParameter.localName)
  ) {
    return false;
  }
  let environmentOverrideCount = 0;
  for (const returned of nestedReturns) {
    if (isExactGuardNilReturn(structuralSource, resolver, returned)) continue;
    if (
      processInfoParameter &&
      isExactEnvironmentOverrideReturn(
        structuralSource,
        resolver,
        returned,
        processInfoParameter.localName,
        keyParameter.localName,
        directTransform === "normalized",
      )
    ) {
      environmentOverrideCount++;
      continue;
    }
    return false;
  }
  return environmentOverrideCount <= 1;
}

function exactDelegatedResolverFlow(
  structuralSource: string,
  valueSource: string,
  typeSymbol: string,
  loadMethod: DirectStaticMethodEvidence,
  reachableMethods: DirectStaticMethodEvidence[],
  resourceEvidence: ExactMainBundleResourceEvidence,
  expression: RedactedExpressionEvidence,
): boolean {
  const loadParameters = topLevelCommaSeparated(loadMethod.parameters);
  if (
    loadParameters.length !== 2 ||
    !loadParameters.some((parameter) =>
      /^bundle\s*:\s*Bundle\s*=\s*(?:Bundle\s*)?\.\s*main$/.test(parameter),
    ) ||
    !loadParameters.some((parameter) =>
      /^processInfo\s*:\s*ProcessInfo\s*=\s*(?:ProcessInfo\s*)?\.\s*processInfo$/.test(parameter),
    ) ||
    hasParameterMutationOrShadowing(structuralSource, loadMethod, "bundle") ||
    hasParameterMutationOrShadowing(structuralSource, loadMethod, "processInfo")
  ) {
    return false;
  }

  const escapedType = escapeRegularExpression(typeSymbol);
  const resolverCall = new RegExp(
    `^\\s*(?:(?:Self|${escapedType})\\s*\\.\\s*)?([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`,
  ).exec(expression.structural);
  const resolverName = resolverCall?.[1];
  if (!resolverCall || !resolverName) return false;
  const openingParenthesis = expression.structural.indexOf("(", resolverCall.index);
  const closingParenthesis = matchingParenthesis(expression.structural, openingParenthesis);
  if (
    closingParenthesis == null ||
    expression.structural.slice(closingParenthesis + 1).trim() !== ""
  ) {
    return false;
  }
  const valueArguments = expression.value.slice(openingParenthesis + 1, closingParenthesis);
  const argumentSegments = topLevelCommaSeparated(valueArguments);
  if (
    argumentSegments.length !== 3 ||
    !argumentSegments.some((argument) => /^for\s*:\s*"CLERK_PUBLISHABLE_KEY"\s*$/.test(argument))
  ) {
    return false;
  }
  const plistArgument = argumentSegments
    .map((argument) => /^plistValues\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(argument)?.[1])
    .find((value): value is string => value != null);
  const processInfoArgument = argumentSegments
    .map((argument) => /^processInfo\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(argument)?.[1])
    .find((value): value is string => value != null);
  if (!plistArgument || processInfoArgument !== "processInfo") return false;

  const resolverCalls = directCallArguments(structuralSource, loadMethod, typeSymbol, resolverName);
  if (resolverCalls.length !== 1) return false;

  const resolverCandidates = reachableMethods.filter((method) => method.name === resolverName);
  if (resolverCandidates.length !== 1) return false;
  const resolver = resolverCandidates[0];
  if (!resolver) return false;
  const resolverParameters = namedParameters(resolver.parameters);
  const keyParameter = resolverParameters.find((parameter) => parameter.externalName === "for");
  const processInfoParameter = resolverParameters.find(
    (parameter) => parameter.externalName === "processInfo",
  );
  const plistParameter = resolverParameters.find(
    (parameter) => parameter.externalName === "plistValues",
  );
  const resolverParameterSegments = topLevelCommaSeparated(resolver.parameters);
  if (
    resolverParameterSegments.length !== 3 ||
    !resolverParameterSegments.some((parameter) =>
      /^for\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*String$/.test(parameter),
    ) ||
    !resolverParameterSegments.some((parameter) =>
      /^processInfo\s*:\s*ProcessInfo$/.test(parameter),
    ) ||
    !resolverParameterSegments.some((parameter) =>
      /^plistValues\s*:\s*\[\s*String\s*:\s*Any\s*\]$/.test(parameter),
    ) ||
    !keyParameter ||
    !processInfoParameter ||
    !plistParameter
  ) {
    return false;
  }
  if (
    !hasExactDelegatedResolverReturnFlow(
      structuralSource,
      valueSource,
      resolver,
      reachableMethods,
      resolverParameters,
      plistParameter,
      keyParameter,
    )
  ) {
    return false;
  }

  const loadBodyStart = loadMethod.openingBrace + 1;
  const structuralLoadBody = structuralSource.slice(loadBodyStart, loadMethod.closingBrace);
  const assignmentPattern = new RegExp(
    `\\blet\\s+${escapeRegularExpression(plistArgument)}\\s*=\\s*(?:(?:Self|${escapedType})\\s*\\.\\s*)?([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`,
    "g",
  );
  const resourceAssignments: Array<{
    method: DirectStaticMethodEvidence;
    arguments: string;
  }> = [];
  let assignment: RegExpExecArray | null;
  while ((assignment = assignmentPattern.exec(structuralLoadBody)) !== null) {
    const assignmentIndex = loadBodyStart + assignment.index;
    if (braceDepthAt(structuralSource, loadMethod.openingBrace, assignmentIndex) !== 1) continue;
    const resourceName = assignment[1];
    if (!resourceName) continue;
    const localOpeningParenthesis = assignment.index + assignment[0].lastIndexOf("(");
    const resourceOpeningParenthesis = loadBodyStart + localOpeningParenthesis;
    const resourceClosingParenthesis = matchingParenthesis(
      structuralSource,
      resourceOpeningParenthesis,
    );
    if (
      resourceClosingParenthesis == null ||
      resourceClosingParenthesis >= loadMethod.closingBrace
    ) {
      continue;
    }
    const candidates = reachableMethods.filter((method) => method.name === resourceName);
    if (candidates.length === 1 && candidates[0]) {
      resourceAssignments.push({
        method: candidates[0],
        arguments: structuralSource.slice(
          resourceOpeningParenthesis + 1,
          resourceClosingParenthesis,
        ),
      });
    }
  }
  if (
    resourceAssignments.length !== 1 ||
    !hasUniqueImmutableInitializedLocal(structuralSource, loadMethod, plistArgument)
  ) {
    return false;
  }
  const resourceAssignment = resourceAssignments[0];
  if (!resourceAssignment || !/^\s*bundle\s*:\s*bundle\s*$/.test(resourceAssignment.arguments)) {
    return false;
  }
  const resourceMethod = resourceAssignment.method;
  const resourceParameters = topLevelCommaSeparated(resourceMethod.parameters);
  if (
    resourceParameters.length !== 1 ||
    !/^bundle\s*:\s*Bundle$/.test(resourceParameters[0] ?? "") ||
    !/^\s*->\s*\[\s*String\s*:\s*Any\s*\]\s*$/.test(resourceMethod.header) ||
    hasParameterMutationOrShadowing(structuralSource, resourceMethod, "bundle")
  ) {
    return false;
  }
  const resourceCalls = directCallArguments(
    structuralSource,
    loadMethod,
    typeSymbol,
    resourceMethod.name,
  );
  if (resourceCalls.length !== 1) return false;

  const decodedDictionaries = correlatedDecodedDictionaryNames(
    structuralSource,
    valueSource,
    resourceMethod,
    resourceEvidence.urlVariablesByMethod.get(resourceMethod.openingBrace) ?? new Set(),
  );
  return (
    directlyReturnedDictionaryName(structuralSource, resourceMethod, decodedDictionaries) != null
  );
}

function loadReturnsExactPublishableKey(
  structuralSource: string,
  valueSource: string,
  typeSymbol: string,
  loadMethod: DirectStaticMethodEvidence,
  reachableMethods: DirectStaticMethodEvidence[],
  resourceEvidence: ExactMainBundleResourceEvidence,
): boolean {
  const expression = returnedPublishableKeyExpression(
    structuralSource,
    valueSource,
    typeSymbol,
    loadMethod,
  );
  if (!expression) return false;
  const directLookupBase = directExactKeyLookupBase(expression.value);
  if (directLookupBase) {
    const decodedDictionaries = correlatedDecodedDictionaryNames(
      structuralSource,
      valueSource,
      loadMethod,
      resourceEvidence.urlVariablesByMethod.get(loadMethod.openingBrace) ?? new Set(),
    );
    return decodedDictionaries.has(directLookupBase);
  }
  return exactDelegatedResolverFlow(
    structuralSource,
    valueSource,
    typeSymbol,
    loadMethod,
    reachableMethods,
    resourceEvidence,
    expression,
  );
}

function provenLocalSecretsRuntimeSymbols(structuralSource: string, valueSource: string): string[] {
  const symbols = new Set<string>();
  const declarationPattern =
    /\b(?:struct|class|enum|actor)\s+((?:[A-Za-z_][A-Za-z0-9_]*)?LocalSecrets)\b/g;
  let declaration: RegExpExecArray | null;

  while ((declaration = declarationPattern.exec(structuralSource)) !== null) {
    const symbol = declaration[1];
    if (
      !symbol ||
      braceDepthAt(structuralSource, 0, declaration.index) !== 0 ||
      isInsideConditionalCompilation(structuralSource, declaration.index)
    ) {
      continue;
    }
    const openingBrace = structuralSource.indexOf("{", declaration.index + declaration[0].length);
    if (openingBrace === -1) continue;
    const headerRemainder = structuralSource.slice(
      declaration.index + declaration[0].length,
      openingBrace,
    );
    if (/[;}]/.test(headerRemainder) || /\b(?:struct|class|enum|actor)\b/.test(headerRemainder)) {
      continue;
    }
    const closingBrace = matchingBrace(structuralSource, openingBrace);
    if (closingBrace == null) continue;

    const structuralBody = structuralSource.slice(openingBrace + 1, closingBrace);
    // Any conditional member makes it ambiguous whether the loader and its
    // resource/key path ship in the selected configuration.
    if (/^[\t ]*#(?:if|elseif|else|endif)\b/m.test(structuralBody)) continue;

    const methods = directStaticMethods(structuralSource, openingBrace, closingBrace);
    const loadEvidence = directZeroArgumentLoadEvidence(methods);
    if (!loadEvidence) continue;
    const reachableMethods = reachableStaticMethods(
      structuralSource,
      symbol,
      methods,
      loadEvidence,
    );
    if (!reachableMethods) continue;

    const resourceEvidence = exactMainBundleResourceEvidence(
      structuralSource,
      valueSource,
      symbol,
      reachableMethods,
      loadEvidence,
    );
    if (
      resourceEvidence.urlVariablesByMethod.size > 0 &&
      loadReturnsExactPublishableKey(
        structuralSource,
        valueSource,
        symbol,
        loadEvidence,
        reachableMethods,
        resourceEvidence,
      )
    ) {
      symbols.add(symbol);
    }
  }

  return [...symbols].sort();
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
  localSecretsSymbol?: string;
  localSecretsUsesCanonicalLoad?: boolean;
} {
  const label = /\bpublishableKey\s*:/.exec(sanitizedCallBody);
  if (!label) return { wiring: "unknown" };
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

  const localSecrets =
    /\b((?:[A-Za-z_][A-Za-z0-9_]*)?LocalSecrets)\b\s*\.\s*(load\s*\(|(?:key|publishableKey)\b)/.exec(
      expression,
    );
  if (localSecrets?.[1]) {
    const canonicalLoad =
      /^\s*((?:[A-Za-z_][A-Za-z0-9_]*)?LocalSecrets)\s*\.\s*load\s*\(\s*\)\s*\.\s*publishableKey\b([\s\S]*)$/.exec(
        expression,
      );
    const remainder = canonicalLoad?.[2] ?? "";
    const originalRemainder = originalExpression.slice(expression.length - remainder.length);
    const canonicalRemainder =
      remainder.trim() === "" || /^\s*\?\?\s*""\s*$/.test(originalRemainder);
    return {
      wiring: "local-secrets-loader",
      localSecretsSymbol: localSecrets[1],
      localSecretsUsesCanonicalLoad: canonicalLoad?.[1] === localSecrets[1] && canonicalRemainder,
    };
  }
  if (
    has(expression, /\bProcessInfo\s*\.\s*processInfo\s*\.\s*environment\b/) &&
    has(
      originalExpression,
      /\bProcessInfo\s*\.\s*processInfo\s*\.\s*environment\s*\[\s*"CLERK_PUBLISHABLE_KEY"\s*\]/,
    )
  ) {
    return { wiring: "process-info-environment" };
  }
  return { wiring: "unknown" };
}

interface PendingConfigureCall extends IOSConfigureCallEvidence {
  localSecretsSymbol?: string;
  localSecretsUsesCanonicalLoad?: boolean;
}

function configureCallEvidence(
  sanitizedSource: string,
  originalSource: string,
  evidence: IOSSourceEvidence,
): PendingConfigureCall[] {
  const calls: PendingConfigureCall[] = [];
  const initializerBodies = mainInitializerBodies(sanitizedSource);
  const pattern = /\bClerk\s*\.\s*configure\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(sanitizedSource)) !== null) {
    const openingParenthesis = sanitizedSource.indexOf("(", match.index);
    const closingParenthesis = matchingParenthesis(sanitizedSource, openingParenthesis);
    if (closingParenthesis == null) {
      calls.push({
        ...evidence,
        publishableKeyWiring: "unknown",
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
      localSecretsSymbol: classification.localSecretsSymbol,
      localSecretsUsesCanonicalLoad: classification.localSecretsUsesCanonicalLoad,
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
  options: { membershipComplete?: boolean } = {},
): Promise<IOSSwiftInspection> {
  const entryPoints: IOSSourceEvidence[] = [];
  const importsClerkKit: IOSSourceEvidence[] = [];
  const importsClerkKitUI: IOSSourceEvidence[] = [];
  const pendingConfigureCalls: PendingConfigureCall[] = [];
  const localSecretsRuntimeBindings: IOSSourceEvidence[] = [];
  const localSecretsRuntimeSymbols = new Set<string>();
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
    const valueSource = sourceWithoutComments(source);
    if (!structuralSource.complete || !valueSource.complete) evidenceComplete = false;
    const sanitized = withoutPreviewOnlyRegions(structuralSource.sanitizedSource);
    const uncommented = withoutPreviewOnlyRegions(valueSource.sanitizedSource);
    const evidence = { path: file.relativePath };
    const importsKit = has(
      sanitized,
      /\bimport\s+(?:(?:typealias|struct|class|enum|protocol|actor|let|var|func|macro)\s+)?ClerkKit\b/,
    );
    const importsUI = has(
      sanitized,
      /\bimport\s+(?:(?:typealias|struct|class|enum|protocol|actor|let|var|func|macro)\s+)?ClerkKitUI\b/,
    );
    const importsClerkModule = importsKit || importsUI;

    if (has(sanitized, /@main\b/)) entryPoints.push(evidence);
    if (importsKit) importsClerkKit.push(evidence);
    if (importsUI) importsClerkKitUI.push(evidence);
    const runtimeSymbols = provenLocalSecretsRuntimeSymbols(sanitized, uncommented);
    for (const symbol of runtimeSymbols) {
      localSecretsRuntimeSymbols.add(symbol);
      localSecretsRuntimeBindings.push(evidence);
    }
    if (importsClerkModule) {
      pendingConfigureCalls.push(...configureCallEvidence(sanitized, source, evidence));
    }
    if (
      importsClerkModule &&
      has(sanitized, /\.\s*environment\s*\(\s*(?:\\?\.\s*self\s*,\s*)?Clerk\s*\.\s*shared\s*\)/)
    ) {
      environmentInjections.push(evidence);
    }
    if (importsClerkModule && has(sanitized, /@Environment\s*\(\s*Clerk\s*\.\s*self\s*\)/)) {
      environmentConsumers.push(evidence);
    }
    if (
      (importsUI && has(sanitized, /\bAuthView\s*\(/)) ||
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
      pendingConfigureCalls.length +
      localSecretsRuntimeBindings.length +
      environmentInjections.length +
      environmentConsumers.length +
      authFlowReferences.length >
    0;
  const status =
    entryPoints.length > 1
      ? "ambiguous"
      : pendingConfigureCalls.length > 0 && environmentInjections.length > 0
        ? "complete"
        : anyClerkEvidence
          ? "partial"
          : "absent";

  const configureCalls: IOSConfigureCallEvidence[] = pendingConfigureCalls.map(
    ({ localSecretsSymbol, localSecretsUsesCanonicalLoad, ...call }) => ({
      ...call,
      ...(call.publishableKeyWiring === "local-secrets-loader" && {
        localSecretsRuntimeBinding:
          localSecretsUsesCanonicalLoad &&
          localSecretsSymbol &&
          localSecretsRuntimeSymbols.has(localSecretsSymbol)
            ? ("proven" as const)
            : ("unproven" as const),
      }),
    }),
  );

  return {
    sourceFilesScanned,
    evidenceComplete,
    entryPoints,
    importsClerkKit,
    importsClerkKitUI,
    configureCalls,
    localSecretsRuntimeBindings,
    environmentInjections,
    environmentConsumers,
    authFlowReferences,
    openURLHandlers,
    status,
  };
}
