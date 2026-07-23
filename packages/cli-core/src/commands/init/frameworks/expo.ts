import { join } from "node:path";
import { findFirstFile, indentBlock, insertAfterLastImport, safeAddImport } from "./helpers.js";
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
 * Find the index just past the parenthesis matching the one at `openIdx`.
 * Tracks string/template literals so brackets inside them don't count.
 * Returns null when the parenthesis never closes (malformed source).
 */
function findMatchingParen(content: string, openIdx: number): number | null {
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
    else if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }

  return null;
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
 * in the file with <ClerkProvider>. The last return is the layout's main
 * render — earlier returns are guards like `if (!loaded) return null`.
 * Returns null when no JSX return exists (unsupported shape — the caller
 * falls back to a post-instruction).
 */
export function wrapLastReturnWithProvider(content: string): string | null {
  const returnIdx = content.lastIndexOf("return (");
  if (returnIdx !== -1) {
    const openIdx = content.indexOf("(", returnIdx);
    const closeIdx = findMatchingParen(content, openIdx);
    if (closeIdx === null) return null;

    const inner = content.slice(openIdx + 1, closeIdx - 1);
    return content.slice(0, openIdx) + wrapJsx(inner) + content.slice(closeIdx);
  }

  // Single-line form: `return <Slot />;` — multi-line JSX without parens is
  // invalid JS (ASI), so the statement always ends on the same line.
  const singleLine = /return\s+(<.*>)\s*;?\s*$/m;
  const match = singleLine.exec(content);
  if (!match) return null;

  return (
    content.slice(0, match.index) +
    `return ${wrapJsx(match[1]!)};` +
    content.slice(match.index + match[0].length)
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

  let newContent = safeAddImport(wrapped, "@clerk/expo", "ClerkProvider");
  newContent = safeAddImport(newContent, "@clerk/expo/token-cache", "tokenCache");
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
