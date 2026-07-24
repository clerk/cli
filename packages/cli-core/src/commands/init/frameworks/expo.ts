import { join } from "node:path";
import { findFirstFile, indentBlock, insertAfterLastImport, safeAddImport } from "./helpers.js";
import { maskCommentsAndStrings } from "./transformations.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

const EXPO_QUICKSTART_URL = "https://clerk.com/docs/expo/getting-started/quickstart";

function missingKeyError(envFile: string): string {
  return `Missing EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY. Add your key to ${envFile}.\\nRun: 1) clerk auth login  2) clerk link  3) clerk env pull — then restart the dev server.`;
}

function publishableKeyBlock(envFile: string): string {
  return `
const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

if (!publishableKey) {
  throw new Error("${missingKeyError(envFile)}");
}
`;
}

function newLayoutContent(envFile: string): string {
  return `import { ClerkProvider } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { Slot } from "expo-router";
${publishableKeyBlock(envFile)}
export default function RootLayout() {
  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <Slot />
    </ClerkProvider>
  );
}
`;
}

/**
 * Find the index just past the delimiter matching the one at `openIdx`.
 * Tracks string/template literals so delimiters inside them don't count.
 * Returns null when the delimiter never closes (malformed source).
 */
function findMatchingDelimiter(
  content: string,
  openIdx: number,
  open: string,
  close: string,
): number | null {
  let depth = 0;
  let quote: string | null = null;

  for (let i = openIdx; i < content.length; i++) {
    const char = content[i]!;

    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }

  return null;
}

/**
 * Locate the body of the default-exported function so return-wrapping never
 * targets a sibling export — expo-router layouts commonly export additional
 * components (e.g. the documented `ErrorBoundary`) from the same file.
 * Returns null when the default export isn't a resolvable function.
 */
function findDefaultExportBody(
  content: string,
  masked: string,
): { start: number; end: number } | null {
  let fnIdx = masked.search(/export\s+default\s+(?:async\s+)?function\b/);

  if (fnIdx === -1) {
    // `export default RootLayout;` referencing a function declared elsewhere.
    const ref = /export\s+default\s+(\w+)/.exec(masked);
    if (!ref) return null;
    fnIdx = masked.search(new RegExp(`\\bfunction\\s+${ref[1]}\\s*\\(`));
    if (fnIdx === -1) return null;
  }

  const paramsOpen = masked.indexOf("(", fnIdx);
  if (paramsOpen === -1) return null;
  const paramsEnd = findMatchingDelimiter(content, paramsOpen, "(", ")");
  if (paramsEnd === null) return null;

  const bodyOpen = masked.indexOf("{", paramsEnd);
  if (bodyOpen === -1) return null;
  const bodyEnd = findMatchingDelimiter(content, bodyOpen, "{", "}");
  if (bodyEnd === null) return null;

  return { start: bodyOpen, end: bodyEnd };
}

/** Strip surrounding blank lines and the common leading indentation so the
 *  wrapped JSX re-indents cleanly regardless of its original nesting depth. */
function dedent(block: string): string {
  const lines = block.split("\n");
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();

  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^ */)![0].length);
  const common = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(common)).join("\n");
}

function wrapJsx(inner: string): string {
  return `(
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
${indentBlock(dedent(inner), "      ")}
    </ClerkProvider>
  )`;
}

/**
 * Wrap the JSX of the last `return ( ... )` or single-line `return <... />`
 * in the default export's body with <ClerkProvider>. The last return is the
 * layout's main render — earlier returns are guards like `if (!loaded)
 * return null`. Returns null when no JSX return exists (unsupported shape —
 * the caller falls back to a post-instruction).
 */
export function wrapLastReturnWithProvider(content: string): string | null {
  const masked = maskCommentsAndStrings(content);

  // Scope the search to the default export so a sibling component's return
  // (e.g. an ErrorBoundary export) is never wrapped by mistake. When the
  // default export isn't a plain function, fall back to the whole file.
  const body = findDefaultExportBody(content, masked);
  const from = body?.start ?? 0;
  const to = body?.end ?? content.length;

  // Searching the masked region keeps commented-out returns from matching.
  const relIdx = masked.slice(from, to).lastIndexOf("return (");
  if (relIdx !== -1) {
    const openIdx = from + relIdx + "return ".length;
    const closeIdx = findMatchingDelimiter(content, openIdx, "(", ")");
    if (closeIdx === null) return null;

    const inner = content.slice(openIdx + 1, closeIdx - 1);
    return content.slice(0, openIdx) + wrapJsx(inner) + content.slice(closeIdx);
  }

  // Single-line form: `return <Slot />;` — multi-line JSX without parens is
  // invalid JS (ASI), so the statement always ends on the same line.
  const singleLine = /return\s+(<.*>)\s*;?\s*$/gm;
  let match: RegExpExecArray | null = null;
  for (const m of content.slice(from, to).matchAll(singleLine)) {
    if (masked[from + m.index] === "r") match = m;
  }
  if (!match) return null;

  const absIdx = from + match.index;
  return (
    content.slice(0, absIdx) +
    `return ${wrapJsx(match[1]!)};` +
    content.slice(absIdx + match[0].length)
  );
}

async function findLayoutFile(ctx: ProjectContext): Promise<string | null> {
  const base = `${ctx.srcDir ? "src/" : ""}app/_layout`;
  return findFirstFile(ctx.cwd, [`${base}.tsx`, `${base}.jsx`, `${base}.js`]);
}

function usesExpoRouter(ctx: ProjectContext): boolean {
  return Boolean(ctx.deps["expo-router"]);
}

async function scaffoldLayout(ctx: ProjectContext): Promise<FileAction | null> {
  const layoutPath = await findLayoutFile(ctx);

  if (!layoutPath) {
    if (!usesExpoRouter(ctx)) return null;
    const ext = ctx.typescript ? "tsx" : "jsx";
    return {
      type: "create",
      path: `${ctx.srcDir ? "src/" : ""}app/_layout.${ext}`,
      content: newLayoutContent(ctx.envFile),
      description: "Create root layout with ClerkProvider and token cache",
    };
  }

  const content = await Bun.file(join(ctx.cwd, layoutPath)).text();

  if (content.includes("ClerkProvider")) {
    return { type: "skip", path: layoutPath, skipReason: "Already has ClerkProvider" };
  }

  const wrapped = wrapLastReturnWithProvider(content);
  if (!wrapped) {
    return {
      type: "skip",
      path: layoutPath,
      skipReason: "Root layout uses an unsupported shape for automatic ClerkProvider wrapping",
    };
  }

  // magicast prepends each new import, so add in reverse of the desired
  // order: ClerkProvider ends up above tokenCache, matching the create path.
  let newContent = safeAddImport(wrapped, "@clerk/expo/token-cache", "tokenCache");
  newContent = safeAddImport(newContent, "@clerk/expo", "ClerkProvider");
  newContent = insertAfterLastImport(newContent, publishableKeyBlock(ctx.envFile));

  return {
    path: layoutPath,
    type: "modify",
    content: newContent,
    description: "Wrap root layout with ClerkProvider and token cache",
  };
}

export const expo: FrameworkScaffold = {
  name: "Expo",
  dep: "expo",

  matches: (ctx) => ctx.framework.dep === "expo",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const layoutAction = await scaffoldLayout(ctx);

    const actions: FileAction[] = [];
    const postInstructions: string[] = [];

    if (layoutAction) {
      actions.push(layoutAction);
    } else {
      postInstructions.push(
        `Wrap your app root with <ClerkProvider> from @clerk/expo (with tokenCache from @clerk/expo/token-cache). See: ${EXPO_QUICKSTART_URL}`,
      );
    }

    const wroteLayout = layoutAction != null && layoutAction.type !== "skip";
    if (wroteLayout && !ctx.deps["expo-secure-store"]) {
      // `npx expo install` (not the package manager) so the version matches the
      // project's Expo SDK — a mismatched native module breaks builds.
      postInstructions.push(
        "Install the secure token store (required by the token cache): `npx expo install expo-secure-store`",
      );
    }

    postInstructions.push(
      `Ensure ${ctx.framework.envVar} is set in your ${ctx.envFile} (pulled via \`clerk env pull\`)`,
      `Add sign-in and sign-up screens, and enable the Native API at https://dashboard.clerk.com/~/native-applications — see: ${EXPO_QUICKSTART_URL}`,
    );

    return { actions, postInstructions };
  },
};
