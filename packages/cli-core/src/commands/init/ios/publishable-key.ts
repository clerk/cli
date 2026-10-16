import { dirname, relative, resolve } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { snapshotFile } from "./files.ts";
import { excludedFromConfiguration, targetSwiftSources } from "./target-sources.ts";
import type { Inspection } from "./xcode.ts";

/**
 * Finds the publishable key one build configuration passes to `Clerk.configure`,
 * when the argument is one the CLI can read without building the app: a Swift
 * string literal, or an Info.plist read whose entry is a literal or a
 * `$(BUILD_SETTING)`. Only the selected target's sources count, less the
 * configuration's excluded files. Anything else (a constant, a call inside `#if`,
 * a fallback, the environment, a bundled file) is reported as unresolved with
 * the reason, never guessed.
 */

type Context = Inspection["contexts"][number];

export type ConfiguredKey =
  | { status: "resolved"; key: string; source: string }
  | { status: "unresolved"; reason: string };

const PUBLISHABLE_KEY = /^pk_(?:test|live)_[A-Za-z0-9+/]+={0,2}$/;
const MAX_FILE_SIZE = 1_000_000;

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

/** Replaces comments and string literals with spaces, keeping newlines, so only code is searched. */
function lex(source: string): string {
  const code = source.split("");
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
      const end = Math.min(source.length, j + delimiter.length);
      blank(i, end);
      i = end;
    } else i++;
  }
  return code.join("");
}

/** Where an expression starting at `start` ends: the first `,`, `;`, or unmatched closer at depth zero. */
function expressionEnd(code: string, start: number): number {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const char = code[i]!;
    if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) {
      if (!depth) return i;
      depth--;
    } else if (!depth && (char === "," || char === ";")) return i;
  }
  return code.length;
}

function scanFile(path: string, absolute: string, source: string): SwiftFile {
  const code = lex(source);
  const calls = [...code.matchAll(/\bClerk\s*\.\s*configure\s*\(\s*publishableKey\s*:/g)].map(
    (match) => {
      const start = match.index! + match[0].length;
      return { position: match.index!, start, end: expressionEnd(code, start) };
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
      // A file left unread could hold the call, so the key is reported as not verified.
      if (file.size > MAX_FILE_SIZE)
        return { files, incomplete: `${relative(root, absolute)} is too large to scan` };
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

const LITERAL = /^(#*)"([^"\\\n]*)"\1$/;
// An Info.plist read whose only fallback, if any, is an empty string (not a key).
const PLIST_READ =
  /^Bundle\s*\.\s*main\s*\.\s*(?:object\s*\(\s*forInfoDictionaryKey\s*:\s*"([^"\\]+)"\s*\)|infoDictionary\s*[?!]?\s*\[\s*"([^"\\]+)"\s*\])\s*(?:as!\s*String|as\?\s*String\s*(?:\?\?\s*""|!)|!)?$/;

function unwrap(text: string): string {
  let value = text.trim();
  while (
    value.startsWith("(") &&
    value.endsWith(")") &&
    expressionEnd(value, 1) === value.length - 1
  )
    value = value.slice(1, -1).trim();
  return value;
}

/** Whether a position in lexed code sits inside an `#if` block. */
function conditional(code: string, position: number): boolean {
  let depth = 0;
  for (const [, kind] of code.slice(0, position).matchAll(/^[ \t]*#(if|endif)\b/gm))
    depth += kind === "if" ? 1 : -1;
  return depth > 0;
}

export async function configuredPublishableKey(
  context: Context,
  scan: SwiftScan,
): Promise<ConfiguredKey> {
  const configuration = context.selection.configuration;
  if (scan.incomplete) return { status: "unresolved", reason: scan.incomplete };
  const files = scan.files.filter(
    (file) => !excludedFromConfiguration(file.absolute, context.settings),
  );
  const calls = files.flatMap((file) => file.calls.map((call) => ({ ...call, file })));
  if (!calls.length)
    return {
      status: "unresolved",
      reason: "no Clerk.configure(publishableKey:) call was found in the target's Swift sources",
    };
  if (calls.some((call) => conditional(call.file.code, call.position)))
    return {
      status: "unresolved",
      reason: `Clerk.configure is inside an #if block, and which branch ${configuration} compiles isn't read without building`,
    };
  if (calls.length > 1)
    return {
      status: "unresolved",
      reason: `the target's Swift sources have ${calls.length} Clerk.configure calls`,
    };
  const [call] = calls;
  const argument = unwrap(call!.file.source.slice(call!.start, call!.end));
  const literal = LITERAL.exec(argument);
  if (literal)
    return PUBLISHABLE_KEY.test(literal[2]!)
      ? { status: "resolved", key: literal[2]!, source: `a string literal in ${call!.file.path}` }
      : {
          status: "unresolved",
          reason: `Clerk.configure in ${call!.file.path} is passed a string that isn't a publishable key`,
        };
  const plist = PLIST_READ.exec(argument);
  if (!plist)
    return {
      status: "unresolved",
      reason: `Clerk.configure in ${call!.file.path} gets its key from code the CLI doesn't read without building the app (for example a constant, a fallback, the environment, or a bundled file)`,
    };
  const name = (plist[1] ?? plist[2])!;
  const entry = await plistValue(context, name);
  if (entry.reason) return { status: "unresolved", reason: entry.reason };
  if (!entry.value || !PUBLISHABLE_KEY.test(entry.value))
    return {
      status: "unresolved",
      reason: entry.setting
        ? `the Info.plist entry ${name} reads the ${entry.setting} build setting, which isn't a publishable key in ${configuration}`
        : `the Info.plist entry ${name} isn't a publishable key`,
    };
  return {
    status: "resolved",
    key: entry.value,
    source: entry.setting
      ? `the Info.plist entry ${name}, set by the ${entry.setting} build setting`
      : `the Info.plist entry ${name}`,
  };
}
