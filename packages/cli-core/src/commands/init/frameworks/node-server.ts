/**
 * Shared scaffolding for Node.js server frameworks (Express, Fastify).
 *
 * Both follow the same quickstart shape: find the server entry file, add a
 * Clerk import, and attach the Clerk middleware/plugin right after the app
 * instance is created. Only the package name, creation pattern, and attach
 * statement differ, so both scaffolders delegate here.
 */
import { join } from "node:path";
import { safeAddImport } from "./transformations.js";
import { maskCommentsAndStrings } from "./source-scan.js";
import { findFirstFile } from "./helpers.js";
import type { FileAction, ProjectContext, ScaffoldPlan } from "./types.js";

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
  /** Quickstart URL for this framework. */
  docsUrl: string;
  /** How to wire Clerk by hand, printed when the entry couldn't be wired. */
  manualWiring: string;
};

/**
 * The entry file's outcome. `wired` says whether Clerk was actually attached,
 * so callers never have to infer it from a human-readable skip reason.
 * `entryPath` is carried out so the setup instructions can name the real file.
 */
type ServerEntry = { action: FileAction | null; wired: boolean; entryPath: string | null };

/** Entry file candidates for Node server projects, most specific first. */
const ENTRY_BASENAMES = ["index", "server", "app", "main"];
const ENTRY_EXTS = ["ts", "mts", "js", "mjs", "cjs"];

// Interleaved by basename, not grouped by directory: putting every `src/` name
// first lets an unrelated `src/app.ts` outrank a root `index.js` real entry.
function entryCandidates(): string[] {
  return ENTRY_BASENAMES.flatMap((base) =>
    ENTRY_EXTS.flatMap((ext) => [`src/${base}.${ext}`, `${base}.${ext}`]),
  );
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
 * Takes masked source so brackets and terminators inside comments or string
 * literals don't count; the returned index applies to the original text.
 */
export function findStatementEnd(masked: string, startIdx: number): number {
  let depth = 0;

  for (let i = startIdx; i < masked.length; i++) {
    const char = masked[i]!;

    if (char === "(" || char === "[" || char === "{") {
      depth++;
    } else if (char === ")" || char === "]" || char === "}") {
      depth--;
    } else if (depth === 0 && (char === ";" || char === "\n")) {
      const rest = masked.slice(i + 1);
      const nextChar = rest.trimStart()[0];
      // A leading `.` or `;` continues the statement (chained call / same line).
      if (nextChar === "." || (char === "\n" && rest.trimStart().startsWith(";"))) continue;
      return char === ";" ? i + 1 : i;
    }
  }

  return masked.length;
}

function isCommonJs(masked: string): boolean {
  return masked.includes("require(") && !/^\s*import\s/m.test(masked);
}

/** Scaffold the Clerk middleware/plugin into a Node server entry file. */
async function scaffoldServerEntry(
  ctx: ProjectContext,
  config: ServerFrameworkConfig,
): Promise<ServerEntry> {
  const entryPath = await findEntryFile(ctx);
  if (!entryPath) return { action: null, wired: false, entryPath: null };

  const content = await Bun.file(join(ctx.cwd, entryPath)).text();

  // Only the framework's own SDK counts as already-configured — an unrelated
  // Clerk package (e.g. @clerk/backend for manual token checks) must not
  // suppress the middleware wiring. This intentionally checks raw content:
  // the package name normally lives inside an import specifier or `require(...)`
  // string, which masking would blank out, breaking detection of legitimately
  // already-wired projects.
  if (content.includes(config.clerkPackage)) {
    const action: FileAction = {
      type: "skip",
      path: entryPath,
      skipReason: `Already has ${config.clerkPackage}`,
    };
    return { action, wired: true, entryPath };
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
    const action: FileAction = {
      type: "skip",
      path: entryPath,
      skipReason: `Could not find where the ${config.frameworkPackage} app is created`,
    };
    return { action, wired: false, entryPath };
  }

  const appVar = match[1]!;
  const statementEnd = findStatementEnd(masked, match.index);

  // CJS files get the require right next to the attach statement — inserting
  // relative to the framework's own require line could land inside a
  // multi-line creation statement like `require("fastify")({\n ... })`.
  const cjs = isCommonJs(masked);
  const attach = cjs
    ? `\nconst { ${config.clerkImport} } = require("${config.clerkPackage}");\n${config.attachStatement(appVar)}`
    : `\n${config.attachStatement(appVar)}`;
  const injected = content.slice(0, statementEnd) + attach + content.slice(statementEnd);

  const action: FileAction = {
    path: entryPath,
    type: "modify",
    content: cjs ? injected : safeAddImport(injected, config.clerkPackage, config.clerkImport),
    description: config.description,
  };
  return { action, wired: true, entryPath };
}

/**
 * Build the full scaffold plan for a Node server framework: wire the entry
 * file and print the setup instructions that wiring can't cover.
 */
export async function scaffoldServerFramework(
  ctx: ProjectContext,
  config: ServerFrameworkConfig,
): Promise<ScaffoldPlan> {
  const { action, wired, entryPath } = await scaffoldServerEntry(ctx, config);

  return {
    actions: action ? [action] : [],
    postInstructions: [
      ...(wired ? [] : [`${config.manualWiring} See: ${config.docsUrl}`]),
      `Ensure ${ctx.framework.envVar} and CLERK_SECRET_KEY are set in your ${ctx.envFile} (pulled via \`clerk env pull\`), and load them before Clerk imports — e.g. \`node --env-file=${ctx.envFile} ${entryPath ?? "index.js"}\``,
      `Protect routes with \`getAuth()\` and \`clerkClient\`: ${config.docsUrl}`,
    ],
  };
}
