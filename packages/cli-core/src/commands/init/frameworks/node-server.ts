/**
 * Shared scaffolding for Node.js server frameworks (Express, Fastify).
 *
 * Both follow the same quickstart shape: find the server entry file, add a
 * Clerk import, and attach the Clerk middleware/plugin right after the app
 * instance is created. Only the package name, creation pattern, and attach
 * statement differ, so both scaffolders delegate here.
 */
import { join } from "node:path";
import { maskCommentsAndStrings, safeAddImport } from "./transformations.js";
import { findFirstFile } from "./helpers.js";
import type { FileAction, ProjectContext } from "./types.js";

export type ServerFrameworkConfig = {
  /** Clerk SDK package, e.g. "@clerk/express". */
  clerkPackage: string;
  /** Named export to import from the Clerk package, e.g. "clerkMiddleware". */
  clerkImport: string;
  /** Matches the app-creation statement and captures the variable name. */
  creationPattern: RegExp;
  /** The framework package to co-locate a CJS require next to, e.g. "express". */
  frameworkPackage: string;
  /** Statement attaching Clerk to the app, given the captured variable name. */
  attachStatement(appVar: string): string;
  /** Human-readable description for the file action. */
  description: string;
};

/** Entry file candidates for Node server projects, most specific first. */
const ENTRY_BASENAMES = ["index", "server", "app", "main"];
const ENTRY_EXTS = ["ts", "mts", "js", "mjs", "cjs"];

function entryCandidates(): string[] {
  const names = ENTRY_BASENAMES.flatMap((base) => ENTRY_EXTS.map((ext) => `${base}.${ext}`));
  return [...names.map((name) => `src/${name}`), ...names];
}

/** Directories that contain build output, never source to scaffold into. */
const BUILD_DIRS = new Set(["dist", "build", "out", "lib"]);

/** Read the package.json "main" field so custom entry points are found first. */
async function readPackageMain(cwd: string): Promise<string | null> {
  try {
    const pkg = await Bun.file(join(cwd, "package.json")).json();
    if (typeof pkg.main !== "string") return null;

    const main = pkg.main.replace(/^\.\//, "");
    // "main" often points at compiled output (e.g. dist/index.js) — skip it so
    // we scaffold into source, not build artifacts.
    if (BUILD_DIRS.has(main.split("/")[0]!)) return null;
    return main;
  } catch {
    return null;
  }
}

async function findEntryFile(ctx: ProjectContext): Promise<string | null> {
  const main = await readPackageMain(ctx.cwd);
  const candidates = main ? [main, ...entryCandidates()] : entryCandidates();
  return findFirstFile(ctx.cwd, candidates);
}

/**
 * Find the end of the statement starting at `startIdx` — the first `;` or
 * newline at bracket depth 0 that is not followed by a chained `.` call.
 * Tracks strings and template literals so brackets inside them don't count.
 * Returns the index just past the statement's last character.
 */
export function findStatementEnd(content: string, startIdx: number): number {
  let depth = 0;
  let quote: string | null = null;

  for (let i = startIdx; i < content.length; i++) {
    const char = content[i]!;

    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "(" || char === "[" || char === "{") {
      depth++;
    } else if (char === ")" || char === "]" || char === "}") {
      depth--;
    } else if (depth === 0 && (char === ";" || char === "\n")) {
      const rest = content.slice(i + 1);
      const nextChar = rest.trimStart()[0];
      // A leading `.` or `;` continues the statement (chained call / same line).
      if (nextChar === "." || (char === "\n" && rest.trimStart().startsWith(";"))) continue;
      return char === ";" ? i + 1 : i;
    }
  }

  return content.length;
}

function isCommonJs(content: string): boolean {
  return content.includes("require(") && !/^\s*import\s/m.test(content);
}

/**
 * True when the user must wire Clerk in manually — no entry file was found,
 * or the entry exists but the app-creation statement couldn't be located.
 */
export function needsManualWiring(action: FileAction | null): boolean {
  return (
    action === null ||
    (action.type === "skip" && (action.skipReason?.startsWith("Could not find") ?? false))
  );
}

/**
 * Scaffold the Clerk middleware/plugin into a Node server entry file.
 * Returns null when no entry file was found (caller prints a post-instruction).
 */
export async function scaffoldServerEntry(
  ctx: ProjectContext,
  config: ServerFrameworkConfig,
): Promise<FileAction | null> {
  const entryPath = await findEntryFile(ctx);
  if (!entryPath) return null;

  const content = await Bun.file(join(ctx.cwd, entryPath)).text();

  // Only the framework's own SDK counts as already-configured — an unrelated
  // Clerk package (e.g. @clerk/backend for manual token checks) must not
  // suppress the middleware wiring.
  if (content.includes(config.clerkPackage)) {
    return { type: "skip", path: entryPath, skipReason: `Already has ${config.clerkPackage}` };
  }

  // A creation statement inside a comment or string (e.g. a commented-out
  // `const app = express();`) must not hijack the insertion point. Matching
  // runs on the real content — the pattern may legitimately span a string
  // like `require("express")` — but a match *starting* in masked territory
  // is commented-out/quoted code and is rejected.
  const masked = maskCommentsAndStrings(content);
  const creation = new RegExp(config.creationPattern.source, "g");
  const match = [...content.matchAll(creation)].find((m) => masked[m.index] === content[m.index]);
  if (!match) {
    return {
      type: "skip",
      path: entryPath,
      skipReason: `Could not find where the ${config.frameworkPackage} app is created`,
    };
  }

  const appVar = match[1]!;
  const statementEnd = findStatementEnd(content, match.index);

  // CJS files get the require right next to the attach statement — inserting
  // relative to the framework's own require line could land inside a
  // multi-line creation statement like `require("fastify")({\n ... })`.
  const cjs = isCommonJs(content);
  const attach = cjs
    ? `\nconst { ${config.clerkImport} } = require("${config.clerkPackage}");\n${config.attachStatement(appVar)}`
    : `\n${config.attachStatement(appVar)}`;
  const injected = content.slice(0, statementEnd) + attach + content.slice(statementEnd);

  return {
    path: entryPath,
    type: "modify",
    content: cjs ? injected : safeAddImport(injected, config.clerkPackage, config.clerkImport),
    description: config.description,
  };
}
