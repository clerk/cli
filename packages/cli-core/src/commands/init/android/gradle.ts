import { unsupported } from "./types.ts";

/**
 * Structural reads of Gradle build scripts (Kotlin and Groovy DSL) and version catalogs. Nothing
 * here evaluates a build: these are literal reads of the common layouts Android Studio writes, and
 * anything else is reported as unsupported rather than guessed.
 */

/** A dotted package name: Gradle `namespace` and `applicationId` values, Kotlin packages. */
export const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** Hides comments (and, by default, string literals) while keeping every offset stable. */
export function maskCode(source: string, strings = true): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    (text) => (!strings && !text.startsWith("/") ? text : text.replace(/[^\r\n]/g, " ")),
  );
}

export interface Block {
  /** Offset of the opening brace. */
  open: number;
  /** Offset of the matching closing brace. */
  close: number;
}

/** Every `name { … }` block in the script, at any depth. */
export function blocks(source: string, name: string): Block[] {
  const masked = maskCode(source);
  const result: Block[] = [];
  for (const match of masked.matchAll(new RegExp(`(?<![\\w.])${name}\\s*\\{`, "g"))) {
    const open = masked.indexOf("{", match.index);
    let depth = 1;
    let close = open;
    while (depth && ++close < masked.length) {
      if (masked[close] === "{") depth++;
      if (masked[close] === "}") depth--;
    }
    if (depth) throw unsupported("Unbalanced block in a Gradle build script.");
    result.push({ open, close });
  }
  return result;
}

/** The blocks of `name` that aren't nested in another block. */
export function topLevelBlocks(source: string, name: string): Block[] {
  const masked = maskCode(source);
  return blocks(source, name).filter((block) => {
    const prefix = masked.slice(0, block.open);
    return (prefix.match(/\{/g) ?? []).length === (prefix.match(/\}/g) ?? []).length;
  });
}

/** The block of `name` directly inside `parent`, when there is exactly one. */
export function childBlock(source: string, parent: Block, name: string): Block | undefined {
  const inner = blocks(source, name).filter(
    (block) => block.open > parent.open && block.close < parent.close,
  );
  return inner.length === 1 ? inner[0] : undefined;
}

/**
 * The string assigned to `name` (`name = "x"`, `name "x"`, or `name("x")`) when the script sets
 * it exactly once with a plain literal. Anything computed, repeated, or interpolated is undefined.
 */
export function literal(source: string, name: string): string | undefined {
  const masked = maskCode(source);
  if ([...masked.matchAll(new RegExp(`(?<![\\w.])${name}\\b`, "g"))].length !== 1) return undefined;
  const matches = [
    ...source.matchAll(
      new RegExp(
        `(?<![\\w.])${name}\\s*(?:=\\s*|\\(\\s*)?["']([^"'$\\r\\n]+)["'](?:[ \\t]*\\))?`,
        "g",
      ),
    ),
  ].filter((match) => masked.slice(match.index, match.index + name.length) === name);
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  const rest = maskCode(source.slice(match.index + match[0].length));
  if (!/^[ \t]*(?:$|[\r\n;}])/.test(rest)) return undefined;
  return match[1];
}

/** The `name = 24` / `name 24` integer when set exactly once as a literal. */
export function integerLiteral(source: string, name: string): number | undefined {
  const masked = maskCode(source);
  const matches = [
    ...masked.matchAll(new RegExp(`(?<![\\w.])${name}\\s*(?:=\\s*)?(\\d+)\\b`, "g")),
  ];
  if (matches.length !== 1) return undefined;
  if ([...masked.matchAll(new RegExp(`(?<![\\w.])${name}\\b`, "g"))].length !== 1) return undefined;
  return Number(matches[0]![1]);
}

export interface Catalog {
  versions: Record<string, string>;
  libraries: Record<string, { module?: string; version?: string; versionRef?: string }>;
  plugins: Record<string, { id?: string; version?: string; versionRef?: string }>;
}

/** The parts of a `libs.versions.toml` this setup reads. Unparseable catalogs are unsupported. */
export function parseCatalog(source: string): Catalog {
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(source) as Record<string, unknown>;
  } catch {
    throw unsupported("gradle/libs.versions.toml could not be parsed.");
  }
  const table = (name: string) =>
    typeof parsed[name] === "object" && parsed[name] && !Array.isArray(parsed[name])
      ? (parsed[name] as Record<string, unknown>)
      : {};
  const versions = Object.fromEntries(
    Object.entries(table("versions")).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : [],
    ),
  );
  const entry = (value: unknown) => {
    if (typeof value === "string") {
      const colon = value.lastIndexOf(":");
      // "group:name:version" or "id:version" for plugins.
      return colon > 0
        ? { literal: value.slice(0, colon), version: value.slice(colon + 1) }
        : { literal: value };
    }
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    const version = record.version;
    return {
      module:
        typeof record.module === "string"
          ? record.module
          : typeof record.group === "string" && typeof record.name === "string"
            ? `${record.group}:${record.name}`
            : undefined,
      id: typeof record.id === "string" ? record.id : undefined,
      version: typeof version === "string" ? version : undefined,
      versionRef:
        version && typeof version === "object" && typeof (version as any).ref === "string"
          ? ((version as any).ref as string)
          : undefined,
    };
  };
  const libraries: Catalog["libraries"] = {};
  for (const [alias, value] of Object.entries(table("libraries"))) {
    const item = entry(value);
    if (!item) continue;
    libraries[alias] =
      "literal" in item
        ? { module: item.literal, version: item.version }
        : { module: item.module, version: item.version, versionRef: item.versionRef };
  }
  const plugins: Catalog["plugins"] = {};
  for (const [alias, value] of Object.entries(table("plugins"))) {
    const item = entry(value);
    if (!item) continue;
    plugins[alias] =
      "literal" in item
        ? { id: item.literal, version: item.version }
        : { id: item.id, version: item.version, versionRef: item.versionRef };
  }
  return { versions, libraries, plugins };
}

/** The resolved version of a catalog library or plugin entry. */
export function catalogVersion(
  catalog: Catalog,
  item: { version?: string; versionRef?: string },
): string | undefined {
  return item.version ?? (item.versionRef ? catalog.versions[item.versionRef] : undefined);
}

/** The type-safe accessor Gradle generates for a catalog alias: `my-lib_name` → `libs.my.lib.name`. */
export function catalogAccessor(
  alias: string,
  kind: "libraries" | "plugins" = "libraries",
): string {
  const path = alias.replace(/[-_]/g, ".");
  return kind === "plugins" ? `libs.plugins.${path}` : `libs.${path}`;
}

/** Whether the build script uses the catalog accessor (`libs.foo.bar`) anywhere outside comments. */
export function usesAccessor(build: string, accessor: string): boolean {
  return new RegExp(`(?<![\\w.])${accessor.replaceAll(".", "\\.")}(?![\\w.])`).test(
    maskCode(build),
  );
}

/** The literal dependency notation lines (`implementation("group:name:version")`) in the script. */
export function literalDependencies(build: string): { coordinate: string; index: number }[] {
  const masked = maskCode(build, false);
  return [
    ...masked.matchAll(
      /(?<![\w.])(?:implementation|api|compileOnly|runtimeOnly|debugImplementation|releaseImplementation)\s*\(?\s*["']([^"'$\r\n]+)["']/g,
    ),
  ].map((match) => ({ coordinate: match[1]!, index: match.index }));
}

/**
 * Appends `line` to the `[section]` table of a TOML catalog, before the next table or at the end
 * of the file. A missing table is added at the end.
 */
export function appendToCatalogSection(source: string, section: string, line: string): string {
  const header = new RegExp(`^\\[${section}\\][ \\t]*(?:#.*)?$`, "m").exec(source);
  if (!header) {
    const separator = source.length === 0 || source.endsWith("\n") ? "" : "\n";
    return `${source}${separator}${source.length ? "\n" : ""}[${section}]\n${line}\n`;
  }
  const after = source.slice(header.index + header[0].length);
  const next = /^\[[^\]]+\][ \t]*(?:#.*)?$/m.exec(after);
  // Keep blank lines that separate tables where they are: insert after the last entry.
  const body = next ? after.slice(0, next.index) : after;
  const trimmed = body.replace(/\s+$/, "");
  const insertAt = header.index + header[0].length + trimmed.length;
  return `${source.slice(0, insertAt)}\n${line}${source.slice(insertAt)}`;
}

/** Inserts `text` as the first line inside a block, matching the indentation of its first entry. */
export function insertIntoBlock(source: string, block: Block, lines: string[]): string {
  const body = source.slice(block.open + 1, block.close);
  const indent = /\n([ \t]+)\S/.exec(body)?.[1] ?? "    ";
  const insertion = lines.map((line) => `\n${indent}${line}`).join("");
  return source.slice(0, block.open + 1) + insertion + source.slice(block.open + 1);
}

export interface SettingsScript {
  /** Gradle project paths from `include(...)`, mapped to their directories relative to the root. */
  projects: Map<string, string>;
  /** Whether the build composes other builds (`includeBuild`), which can supply convention plugins. */
  includesBuilds: boolean;
}

/**
 * What a `settings.gradle(.kts)` says about the build's layout: every `include(":a", ":b:c")` or
 * `include ':a', ':b'`, and `project(":a").projectDir = file("dir")` remaps. Anything computed is
 * left out, so a project path may be missing, never wrong.
 */
export function parseSettings(source: string): SettingsScript {
  const visible = maskCode(source, false);
  const projects = new Map<string, string>();
  for (const match of visible.matchAll(
    /(?<![\w.])include\s*\(?\s*((?:["'][^"'\r\n]+["']\s*,?\s*)+)\)?/g,
  ))
    for (const path of match[1]!.matchAll(/["']([^"'\r\n]+)["']/g)) {
      const name = path[1]!.startsWith(":") ? path[1]! : `:${path[1]!}`;
      projects.set(name, name.slice(1).split(":").join("/"));
    }
  for (const match of visible.matchAll(
    /(?<![\w.])project\s*\(\s*["']([^"'\r\n]+)["']\s*\)\s*\.\s*projectDir\s*=\s*(?:new\s+File|file)\s*\(\s*["']([^"'\r\n$]+)["']\s*\)/g,
  )) {
    const name = match[1]!.startsWith(":") ? match[1]! : `:${match[1]!}`;
    if (projects.has(name)) projects.set(name, match[2]!.replace(/^\.\//, "").replace(/\/$/, ""));
  }
  return { projects, includesBuilds: /(?<![\w.])includeBuild\s*\(/.test(visible) };
}

/** The plugin ids a build script applies literally (`id("x")`, `kotlin("x")`, Groovy `id 'x'`). */
export function literalPluginIds(source: string): string[] {
  const visible = maskCode(source, false);
  const ids: string[] = [];
  for (const match of visible.matchAll(/(?<![\w.])id\s*\(?\s*["']([^"'\r\n]+)["']/g))
    ids.push(match[1]!);
  for (const match of visible.matchAll(/(?<![\w.])kotlin\s*\(\s*["']([^"'\r\n]+)["']\s*\)/g))
    ids.push(`org.jetbrains.kotlin.${match[1]!}`);
  return ids;
}

/** The catalog plugin aliases a build script applies (`alias(libs.plugins.x.y)`). */
export function aliasedPluginIds(
  source: string,
  catalog?: Catalog,
): { known: string[]; unresolved: number } {
  const visible = maskCode(source, false);
  const known: string[] = [];
  let unresolved = 0;
  for (const match of visible.matchAll(/(?<![\w.])alias\s*\(\s*libs\.plugins\.([\w.]+)\s*\)/g)) {
    const accessor = `libs.plugins.${match[1]!}`;
    const entry = Object.entries(catalog?.plugins ?? {}).find(
      ([alias]) => catalogAccessor(alias, "plugins") === accessor,
    );
    if (entry?.[1].id) known.push(entry[1].id);
    else unresolved++;
  }
  return { known, unresolved };
}
