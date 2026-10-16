import { lstat, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { snapshotFile } from "./files.ts";
import type { Inspection } from "./xcode.ts";

/**
 * Finds the publishable key one build configuration passes to `Clerk.configure`,
 * when the app loads it in a standard way that can be read without building:
 * a Swift string literal, an Info.plist entry (literal or `$(BUILD_SETTING)`),
 * or the one key literal compiled into that configuration. Anything else is
 * reported as unresolved with the reason, never guessed.
 */

type Context = Inspection["contexts"][number];

export type ConfiguredKey =
  | { status: "resolved"; key: string; source: string }
  | { status: "unresolved"; reason: string };

const PUBLISHABLE_KEY = /^pk_(?:test|live)_[A-Za-z0-9+/]+={0,2}$/;
// Build products, dependencies, and test bundles, which may configure Clerk with their own keys.
const SKIPPED_DIRECTORIES =
  /^(?:\..*|build|DerivedData|Pods|Carthage|SourcePackages|node_modules|.*\.(?:xcodeproj|xcworkspace|app|framework|xcframework)|.*Tests)$/;
const MAX_FILES = 2000;
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
  path: string;
  literals: (Literal & { frames: Frame[] })[];
  calls: { frames: Frame[]; literal?: string; expression: boolean }[];
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

function scanFile(path: string, source: string): SwiftFile {
  const { code, literals } = lex(source);
  const calls: { position: number; literal?: string; expression: boolean }[] = [];
  for (const match of code.matchAll(/\bClerk\s*\.\s*configure\s*\(\s*publishableKey\s*:/g)) {
    // Literals are blanked in `code`, so find the argument's start in the source.
    const colon = match.index! + match[0].length;
    const start = colon + Math.max(0, source.slice(colon).search(/\S/));
    const literal = literals.find((item) => item.start === start && item.value !== undefined);
    const whole = literal && /^\s*[,)]/.test(code.slice(literal.end));
    calls.push({
      position: match.index!,
      literal: whole ? literal.value : undefined,
      expression: !whole,
    });
  }
  const frames = framesAt(code, [
    ...calls.map((call) => call.position),
    ...literals.map((literal) => literal.start),
  ]);
  return {
    path,
    calls: calls.map((call, index) => ({
      frames: frames[index]!,
      literal: call.literal,
      expression: call.expression,
    })),
    literals: literals.map((literal, index) => ({
      ...literal,
      frames: frames[calls.length + index]!,
    })),
  };
}

/** Reads the project's Swift sources once; every configuration is evaluated against the same scan. */
export async function scanSwiftSources(inspection: Inspection): Promise<SwiftScan> {
  const { selection, settings } = inspection.contexts[0]!;
  const sourceRoot = settings.SRCROOT ?? resolve(selection.root, dirname(selection.project));
  const files: SwiftFile[] = [];
  let count = 0;
  const walk = async (directory: string): Promise<string | undefined> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.test(entry.name)) continue;
        const stopped = await walk(path);
        if (stopped) return stopped;
      } else if (entry.isFile() && entry.name.endsWith(".swift")) {
        if (++count > MAX_FILES) return `the project has more than ${MAX_FILES} Swift files`;
        if ((await lstat(path)).size > MAX_FILE_SIZE) continue;
        files.push(scanFile(relative(selection.root, path), await Bun.file(path).text()));
      }
    }
    return undefined;
  };
  try {
    const incomplete = await walk(sourceRoot);
    return { files, incomplete };
  } catch {
    return { files, incomplete: "the Swift sources could not be read" };
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

/** Info.plist entries that hold a publishable key in this configuration, directly or through a build setting. */
async function plistKeys(context: Context) {
  const { settings, selection } = context;
  const path = settings.INFOPLIST_FILE;
  if (!path) return { entries: [] };
  if (settings.INFOPLIST_PREPROCESS === "YES")
    return { entries: [], reason: "the Info.plist is preprocessed" };
  let strings: Map<string, string> | undefined;
  try {
    const sourceRoot = settings.SRCROOT ?? resolve(selection.root, dirname(selection.project));
    strings = plistStrings((await snapshotFile(selection.root, resolve(sourceRoot, path))).source);
  } catch {
    strings = undefined;
  }
  if (!strings) return { entries: [], reason: "the Info.plist could not be read" };
  const entries: { name: string; key: string; setting?: string }[] = [];
  for (const [name, raw] of strings) {
    const reference = /^\$(?:\(([A-Za-z_]\w*)\)|\{([A-Za-z_]\w*)\})$/.exec(raw.trim());
    const setting = reference ? (reference[1] ?? reference[2]) : undefined;
    const value = setting ? settings[setting] : raw.trim();
    if (value && PUBLISHABLE_KEY.test(value)) entries.push({ name, key: value, setting });
  }
  return { entries };
}

export async function configuredPublishableKey(
  context: Context,
  scan: SwiftScan,
): Promise<ConfiguredKey> {
  const configuration = context.selection.configuration;
  if (scan.incomplete) return { status: "unresolved", reason: `${scan.incomplete}` };
  const flags = compilationFlags(context.settings);
  const calls = scan.files.flatMap((file) =>
    file.calls.map((call) => ({ ...call, path: file.path, active: active(call.frames, flags) })),
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
        : "no Clerk.configure(publishableKey:) call was found in the project's Swift sources",
    };
  if (compiled.length > 1)
    return {
      status: "unresolved",
      reason: `${compiled.length} Clerk.configure calls are compiled into ${configuration}`,
    };
  const [call] = compiled;
  if (!call!.expression) {
    if (!PUBLISHABLE_KEY.test(call!.literal ?? ""))
      return {
        status: "unresolved",
        reason: `Clerk.configure in ${call!.path} is passed a string that isn't a publishable key`,
      };
    return { status: "resolved", key: call!.literal!, source: `a string literal in ${call!.path}` };
  }
  // The key comes from an expression: follow it only to an Info.plist entry the
  // Swift sources name, or to the one key literal compiled into this configuration.
  const literals = scan.files.flatMap((file) =>
    file.literals
      .filter((literal) => literal.value !== undefined && active(literal.frames, flags) !== false)
      .map((literal) => ({ ...literal, path: file.path, active: active(literal.frames, flags) })),
  );
  const names = new Set(literals.map((literal) => literal.value));
  const plist = await plistKeys(context);
  const entries = plist.entries.filter((entry) => names.has(entry.name));
  const keys = literals.filter((literal) => PUBLISHABLE_KEY.test(literal.value!));
  if (keys.some((literal) => literal.active === undefined))
    return {
      status: "unresolved",
      reason:
        "a publishable key literal is inside a compilation condition that depends on more than build flags",
    };
  const distinctKeys = [...new Set(keys.map((literal) => literal.value!))];
  if (entries.length === 1 && !distinctKeys.length) {
    const [entry] = entries;
    return {
      status: "resolved",
      key: entry!.key,
      source: entry!.setting
        ? `the Info.plist entry ${entry!.name}, set by the ${entry!.setting} build setting`
        : `the Info.plist entry ${entry!.name}`,
    };
  }
  if (!entries.length && distinctKeys.length === 1)
    return {
      status: "resolved",
      key: distinctKeys[0]!,
      source: `a string literal in ${keys.find((literal) => literal.value === distinctKeys[0])!.path}`,
    };
  if (entries.length || distinctKeys.length)
    return {
      status: "unresolved",
      reason: `more than one publishable key could reach Clerk.configure in ${configuration}`,
    };
  return {
    status: "unresolved",
    reason:
      plist.reason ??
      `Clerk.configure in ${call!.path} loads its key in a way the CLI can't read without building the app (for example a bundled file, the environment, or a build script)`,
  };
}
