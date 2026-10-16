import { dirname, relative, resolve } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { snapshotFile } from "./files.ts";
import { excludedFromConfiguration, targetSwiftSources } from "./target-sources.ts";
import type { Inspection } from "./xcode.ts";

/**
 * Finds the publishable key one build configuration passes to `Clerk.configure`,
 * when the argument can be followed to it without building the app: a Swift
 * string literal, an Info.plist read (literal or `$(BUILD_SETTING)`), or a
 * constant declared as one of those. Only the selected target's sources count,
 * less the configuration's excluded files. A fallback (`?? "pk_…"`), the
 * environment, a bundled file, or anything else is reported as unresolved with
 * the reason, never guessed.
 */

type Context = Inspection["contexts"][number];

export type ConfiguredKey =
  | { status: "resolved"; key: string; source: string }
  | { status: "unresolved"; reason: string };

const PUBLISHABLE_KEY = /^pk_(?:test|live)_[A-Za-z0-9+/]+={0,2}$/;
const MAX_FILE_SIZE = 1_000_000;

interface Literal {
  start: number;
  end: number;
  /** Undefined when the literal is interpolated, escaped, or multi-line. */
  value: string | undefined;
}

/** One `#if` chain open at a position: the conditions of its earlier branches and of the current one (null for `#else`). */
interface Frame {
  prior: string[];
  current: string | null;
}

interface SwiftFile {
  /** Relative to the project root, for messages. */
  path: string;
  absolute: string;
  source: string;
  /** The source with comments and string literals blanked, for finding structure. */
  code: string;
  /** Each `Clerk.configure(publishableKey:)` call and where its argument starts and ends. */
  calls: { position: number; start: number; end: number }[];
}

export interface SwiftScan {
  files: SwiftFile[];
  /** Set when the sources can't be scanned completely. */
  incomplete?: string;
}

/** Replaces comments and string literals with spaces (keeping newlines) and records each literal. */
function lex(source: string): { code: string; literals: Literal[] } {
  const code = source.split("");
  const literals: Literal[] = [];
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (code[i] !== "\n") code[i] = " ";
  };
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (source.startsWith("/*", i)) {
      let depth = 0;
      let j = i;
      while (j < source.length) {
        if (source.startsWith("/*", j)) {
          depth++;
          j += 2;
        } else if (source.startsWith("*/", j)) {
          depth--;
          j += 2;
          if (!depth) break;
        } else j++;
      }
      blank(i, j);
      i = j;
    } else if (source[i] === '"' || (source[i] === "#" && /^#+"/.test(source.slice(i, i + 9)))) {
      const hashes = /^#*/.exec(source.slice(i))![0].length;
      const open = i + hashes;
      const multiline = source.startsWith('"""', open);
      const delimiter = (multiline ? '"""' : '"') + "#".repeat(hashes);
      const contentStart = open + (multiline ? 3 : 1);
      let j = contentStart;
      while (j < source.length && !source.startsWith(delimiter, j)) {
        if (!hashes && source[j] === "\\") j++;
        else if (!multiline && source[j] === "\n") break;
        j++;
      }
      const content = source.slice(contentStart, j);
      const end = Math.min(source.length, j + delimiter.length);
      const escaped = hashes ? content.includes(`\\${"#".repeat(hashes)}`) : content.includes("\\");
      literals.push({ start: i, end, value: multiline || escaped ? undefined : content });
      blank(i, end);
      i = end;
    } else i++;
  }
  return { code: code.join(""), literals };
}

/** The `#if` chains open at each requested position, in source order. */
function framesAt(code: string, positions: number[]): Frame[][] {
  const directives = [...code.matchAll(/^[ \t]*#(if|elseif|else|endif)\b([^\n]*)/gm)];
  const stack: Frame[] = [];
  const result: Frame[][] = [];
  let next = 0;
  const order = positions.map((position, index) => ({ position, index }));
  order.sort((a, b) => a.position - b.position);
  for (const { position, index } of order) {
    while (next < directives.length && directives[next]!.index! < position) {
      const [, kind, rest] = directives[next++]!;
      const condition = rest!.trim();
      const top = stack.at(-1);
      if (kind === "if") stack.push({ prior: [], current: condition });
      else if (kind === "endif") stack.pop();
      else if (top) {
        if (top.current !== null) top.prior.push(top.current);
        top.current = kind === "else" ? null : condition;
      }
    }
    result[index] = stack.map((frame) => ({ prior: [...frame.prior], current: frame.current }));
  }
  return result;
}

/** Three-valued evaluation of a compilation condition; undefined when it depends on more than flags. */
function evaluate(condition: string, flags: Set<string>): boolean | undefined {
  const tokens = condition.match(/&&|\|\||[!()]|[A-Za-z_][A-Za-z0-9_]*|\S/g) ?? [];
  let position = 0;
  const or = (): boolean | undefined => {
    let value = and();
    while (tokens[position] === "||") {
      position++;
      const right = and();
      value =
        value === true || right === true
          ? true
          : value === false && right === false
            ? false
            : undefined;
    }
    return value;
  };
  const and = (): boolean | undefined => {
    let value = unary();
    while (tokens[position] === "&&") {
      position++;
      const right = unary();
      value =
        value === false || right === false
          ? false
          : value === true && right === true
            ? true
            : undefined;
    }
    return value;
  };
  const unary = (): boolean | undefined => {
    if (tokens[position] === "!") {
      position++;
      const value = unary();
      return value === undefined ? undefined : !value;
    }
    const token = tokens[position++];
    if (token === "(") {
      const value = or();
      if (tokens[position++] !== ")") throw new Error("Unbalanced condition.");
      return value;
    }
    if (!token || !/^[A-Za-z_]/.test(token)) throw new Error("Unexpected condition token.");
    // os(iOS), canImport(X), swift(>=6): not decidable from build settings.
    if (tokens[position] === "(") {
      let depth = 0;
      do {
        if (tokens[position] === "(") depth++;
        else if (tokens[position] === ")") depth--;
        position++;
      } while (depth && position < tokens.length);
      return undefined;
    }
    if (token === "true") return true;
    if (token === "false") return false;
    return flags.has(token);
  };
  try {
    const value = or();
    return position === tokens.length ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Whether code under these `#if` chains is compiled with these flags; undefined when unknown. */
function active(frames: Frame[], flags: Set<string>): boolean | undefined {
  let result: boolean | undefined = true;
  for (const frame of frames) {
    for (const prior of frame.prior) {
      const value = evaluate(prior, flags);
      if (value === true) return false;
      if (value === undefined) result = undefined;
    }
    if (frame.current !== null) {
      const value = evaluate(frame.current, flags);
      if (value === false) return false;
      if (value === undefined) result = undefined;
    }
  }
  return result;
}

/** Swift compilation flags for a configuration: SWIFT_ACTIVE_COMPILATION_CONDITIONS plus `-D` flags. */
function compilationFlags(settings: Record<string, string>): Set<string> {
  const flags = new Set(
    (settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS ?? "").split(/\s+/).filter(Boolean),
  );
  for (const match of (settings.OTHER_SWIFT_FLAGS ?? "").matchAll(/(?:^|\s)-D\s*([A-Za-z_]\w*)/g))
    flags.add(match[1]!);
  return flags;
}

/** Where an expression starting at `start` ends: the first `,` or unmatched closer at depth zero, or the line's end. */
function expressionEnd(code: string, start: number, stopAtLine: boolean): number {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const char = code[i]!;
    if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) {
      if (!depth) return i;
      depth--;
    } else if (!depth && (char === "," || char === ";" || (stopAtLine && char === "\n"))) return i;
  }
  return code.length;
}

function scanFile(path: string, absolute: string, source: string): SwiftFile {
  const { code } = lex(source);
  const calls = [...code.matchAll(/\bClerk\s*\.\s*configure\s*\(\s*publishableKey\s*:/g)].map(
    (match) => {
      const start = match.index! + match[0].length;
      return { position: match.index!, start, end: expressionEnd(code, start, false) };
    },
  );
  return { path, absolute, source, code, calls };
}

/** Reads the target's Swift sources once; every configuration is evaluated against the same scan. */
export async function scanSwiftSources(inspection: Inspection): Promise<SwiftScan> {
  const sources = await targetSwiftSources(inspection);
  if ("reason" in sources) return { files: [], incomplete: sources.reason };
  const root = inspection.contexts[0]!.selection.root;
  const files: SwiftFile[] = [];
  try {
    for (const absolute of sources.files) {
      const file = Bun.file(absolute);
      if (file.size > MAX_FILE_SIZE) continue;
      files.push(scanFile(relative(root, absolute), absolute, await file.text()));
    }
    return { files };
  } catch {
    return { files, incomplete: "the target's Swift sources could not be read" };
  }
}

/** Top-level string entries of an XML property list; undefined when it isn't one ordinary dictionary. */
function plistStrings(source: string): Map<string, string> | undefined {
  if (/<!ENTITY/i.test(source)) return undefined;
  try {
    const xml = new DOMParser({
      errorHandler: () => {
        throw new Error("Invalid plist.");
      },
    }).parseFromString(source, "text/xml");
    const root = xml.documentElement;
    const dictionaries = Array.from(root.childNodes).filter((node) => node.nodeType === 1);
    if (
      root.tagName !== "plist" ||
      dictionaries.length !== 1 ||
      dictionaries[0]!.nodeName !== "dict"
    )
      return undefined;
    const children = Array.from(dictionaries[0]!.childNodes).filter((node) => node.nodeType === 1);
    const strings = new Map<string, string>();
    for (let i = 0; i + 1 < children.length; i += 2)
      if (children[i]!.nodeName === "key" && children[i + 1]!.nodeName === "string")
        strings.set(children[i]!.textContent ?? "", children[i + 1]!.textContent ?? "");
    return strings;
  } catch {
    return undefined;
  }
}

/** The value an Info.plist entry has in this configuration, through a `$(BUILD_SETTING)` when it names one. */
async function plistValue(
  context: Context,
  name: string,
): Promise<{ value?: string; setting?: string; reason?: string }> {
  const { settings, selection } = context;
  const path = settings.INFOPLIST_FILE;
  if (!path) return { reason: `the target has no Info.plist file for its ${name} entry` };
  if (settings.INFOPLIST_PREPROCESS === "YES") return { reason: "the Info.plist is preprocessed" };
  let strings: Map<string, string> | undefined;
  try {
    const sourceRoot = settings.SRCROOT ?? resolve(selection.root, dirname(selection.project));
    strings = plistStrings((await snapshotFile(selection.root, resolve(sourceRoot, path))).source);
  } catch {
    strings = undefined;
  }
  if (!strings) return { reason: "the Info.plist could not be read" };
  const raw = strings.get(name)?.trim();
  if (raw === undefined) return { reason: `the Info.plist has no ${name} string entry` };
  const reference = /^\$(?:\(([A-Za-z_]\w*)\)|\{([A-Za-z_]\w*)\})$/.exec(raw);
  const setting = reference ? (reference[1] ?? reference[2]) : undefined;
  return { value: setting ? settings[setting] : raw, setting };
}

type Trace =
  | { kind: "literal"; value: string; path: string }
  | { kind: "plist"; name: string }
  | { kind: "unresolved"; reason: string };

const LITERAL = /^(#*)"([^"\\\n]*)"\1$/;
// An Info.plist read whose only fallback, if any, is an empty string (not a key).
const PLIST_READ =
  /^Bundle\s*\.\s*main\s*\.\s*(?:object\s*\(\s*forInfoDictionaryKey\s*:\s*"([^"\\]+)"\s*\)|infoDictionary\s*[?!]?\s*\[\s*"([^"\\]+)"\s*\])\s*(?:as!\s*String|as\?\s*String\s*(?:\?\?\s*""|!)|!)?$/;
const IDENTIFIER = /^(?:[A-Za-z_]\w*\s*\.\s*)*([A-Za-z_]\w*)$/;

function unwrap(text: string): string {
  let value = text.trim();
  while (
    value.startsWith("(") &&
    value.endsWith(")") &&
    expressionEnd(value, 1, false) === value.length - 1
  )
    value = value.slice(1, -1).trim();
  return value;
}

/**
 * Follows an expression to where its value comes from: a literal, an Info.plist read, or a
 * constant (exactly one declaration compiled into this configuration) declared as one of those.
 */
function trace(
  text: string,
  path: string,
  files: SwiftFile[],
  flags: Set<string>,
  depth = 0,
): Trace {
  const expression = unwrap(text);
  const literal = LITERAL.exec(expression);
  if (literal) return { kind: "literal", value: literal[2]!, path };
  const plist = PLIST_READ.exec(expression);
  if (plist) return { kind: "plist", name: (plist[1] ?? plist[2])! };
  const identifier = IDENTIFIER.exec(expression);
  if (!identifier || depth > 4)
    return {
      kind: "unresolved",
      reason: `Clerk.configure in ${path} gets its key from code the CLI can't follow without building the app (for example a fallback, the environment, a bundled file, or a build script)`,
    };
  const name = identifier[1]!;
  const declarations = files.flatMap((file) =>
    [
      ...file.code.matchAll(new RegExp(`\\b(?:let|var)\\s+${name}\\s*(?::\\s*String\\s*)?=`, "g")),
    ].map((match) => {
      const start = match.index! + match[0].length;
      return {
        file,
        active: active(framesAt(file.code, [match.index!])[0]!, flags),
        text: file.source.slice(start, expressionEnd(file.code, start, true)),
      };
    }),
  );
  if (declarations.some((declaration) => declaration.active === undefined))
    return {
      kind: "unresolved",
      reason: `${name} is declared inside a compilation condition that depends on more than build flags`,
    };
  const compiled = declarations.filter((declaration) => declaration.active);
  if (compiled.length !== 1)
    return {
      kind: "unresolved",
      reason: compiled.length
        ? `${name} is declared more than once, so which value reaches Clerk.configure is unclear`
        : `${name} isn't a constant the CLI can read (it's computed, or declared outside the target)`,
    };
  const [declaration] = compiled;
  return trace(declaration!.text, declaration!.file.path, files, flags, depth + 1);
}

export async function configuredPublishableKey(
  context: Context,
  scan: SwiftScan,
): Promise<ConfiguredKey> {
  const configuration = context.selection.configuration;
  if (scan.incomplete) return { status: "unresolved", reason: scan.incomplete };
  const flags = compilationFlags(context.settings);
  const files = scan.files.filter(
    (file) => !excludedFromConfiguration(file.absolute, context.settings),
  );
  const calls = files.flatMap((file) =>
    file.calls.map((call) => ({
      ...call,
      file,
      active: active(framesAt(file.code, [call.position])[0]!, flags),
    })),
  );
  if (calls.some((call) => call.active === undefined))
    return {
      status: "unresolved",
      reason:
        "Clerk.configure is inside a compilation condition that depends on more than build flags",
    };
  const compiled = calls.filter((call) => call.active);
  if (!compiled.length)
    return {
      status: "unresolved",
      reason: calls.length
        ? `no Clerk.configure call is compiled into ${configuration}`
        : "no Clerk.configure(publishableKey:) call was found in the target's Swift sources",
    };
  if (compiled.length > 1)
    return {
      status: "unresolved",
      reason: `${compiled.length} Clerk.configure calls are compiled into ${configuration}`,
    };
  const [call] = compiled;
  const found = trace(
    call!.file.source.slice(call!.start, call!.end),
    call!.file.path,
    files,
    flags,
  );
  if (found.kind === "unresolved") return { status: "unresolved", reason: found.reason };
  if (found.kind === "literal")
    return PUBLISHABLE_KEY.test(found.value)
      ? { status: "resolved", key: found.value, source: `a string literal in ${found.path}` }
      : {
          status: "unresolved",
          reason: `Clerk.configure in ${call!.file.path} is passed a string that isn't a publishable key`,
        };
  const entry = await plistValue(context, found.name);
  if (entry.reason) return { status: "unresolved", reason: entry.reason };
  if (!entry.value || !PUBLISHABLE_KEY.test(entry.value))
    return {
      status: "unresolved",
      reason: entry.setting
        ? `the Info.plist entry ${found.name} reads the ${entry.setting} build setting, which isn't a publishable key in ${configuration}`
        : `the Info.plist entry ${found.name} isn't a publishable key`,
    };
  return {
    status: "resolved",
    key: entry.value,
    source: entry.setting
      ? `the Info.plist entry ${found.name}, set by the ${entry.setting} build setting`
      : `the Info.plist entry ${found.name}`,
  };
}
