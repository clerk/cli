import { join } from "node:path";
import { findFirstFile, indentBlock, insertAfterLastImport, safeAddImport } from "./helpers.js";
import { findMatchingDelimiter, maskCommentsAndStrings } from "./source-scan.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

const EXPO_QUICKSTART_URL = "https://clerk.com/docs/expo/getting-started/quickstart";

function missingKeyError(envFile: string): string {
  return `Missing EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY. Add your key to ${envFile}.\\nRun: 1) clerk auth login  2) clerk link  3) clerk env pull — then restart the dev server.`;
}

/** The `?? ""` types the const as plain string: the layout is a hoistable
 *  function declaration, so TS won't narrow `string | undefined` through the
 *  throw guard into it, and ClerkProvider's publishableKey prop requires
 *  string. The guard still throws on the empty fallback. */
function publishableKeyBlock(envFile: string): string {
  return `
const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";

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

/** A half-open `[start, end)` range over the source. */
type Span = { start: number; end: number };

/** An arrow function's head, up to and including the `=>`. Anchoring the arrow
 *  to the declaration keeps the body search from skipping ahead to an
 *  unrelated arrow further down the file. */
const ARROW_HEAD = String.raw`(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>`;

function braceBody(masked: string, bodyOpen: number): Span | null {
  const bodyEnd = findMatchingDelimiter(masked, bodyOpen, "{", "}");
  return bodyEnd === null ? null : { start: bodyOpen, end: bodyEnd };
}

/** Params are matched first so a default value containing a brace can't be
 *  mistaken for the start of the body. */
function findBodyAfterParams(masked: string, fnIdx: number): Span | null {
  const paramsOpen = masked.indexOf("(", fnIdx);
  if (paramsOpen === -1) return null;
  const paramsEnd = findMatchingDelimiter(masked, paramsOpen, "(", ")");
  if (paramsEnd === null) return null;

  const bodyOpen = masked.indexOf("{", paramsEnd);
  return bodyOpen === -1 ? null : braceBody(masked, bodyOpen);
}

/** Only block bodies resolve — a concise body (`=> <Slot />`) has no `return`
 *  to wrap, so the caller reports an unsupported shape rather than guessing. */
function findArrowBody(masked: string, headIdx: number): Span | null {
  const arrow = masked.indexOf("=>", headIdx);
  if (arrow === -1) return null;

  const bodyOpen = arrow + 2 + /^\s*/.exec(masked.slice(arrow + 2))![0].length;
  return masked[bodyOpen] === "{" ? braceBody(masked, bodyOpen) : null;
}

/**
 * Locate the body of the default-exported component so return-wrapping never
 * targets a sibling export — expo-router layouts commonly export additional
 * components (e.g. the documented `ErrorBoundary`) from the same file.
 *
 * Returns null for shapes it can't resolve (a HOC-wrapped export, a concise
 * arrow body). The caller treats that as "unsupported" rather than falling
 * back to the whole file.
 */
function findDefaultExportBody(masked: string): Span | null {
  const fnDecl = /export\s+default\s+(?:async\s+)?function\b/.exec(masked);
  if (fnDecl) return findBodyAfterParams(masked, fnDecl.index);

  const inlineArrow = new RegExp(String.raw`export\s+default\s+${ARROW_HEAD}`).exec(masked);
  if (inlineArrow) return findArrowBody(masked, inlineArrow.index);

  // `export default RootLayout;` referencing a declaration elsewhere.
  const ref = /export\s+default\s+(\w+)/.exec(masked);
  if (!ref) return null;
  const name = ref[1]!; // \w+ only — safe to interpolate into a RegExp

  const namedFn = masked.search(new RegExp(String.raw`\bfunction\s+${name}\s*\(`));
  if (namedFn !== -1) return findBodyAfterParams(masked, namedFn);

  // `const RootLayout = () => {}`, with an optional type annotation.
  const binding = String.raw`\b(?:const|let|var)\s+${name}\s*(?::[^=]*)?=\s*`;

  const namedArrow = new RegExp(binding + ARROW_HEAD).exec(masked);
  if (namedArrow) return findArrowBody(masked, namedArrow.index);

  const namedFnExpr = new RegExp(binding + String.raw`(?:async\s+)?function\b`).exec(masked);
  if (namedFnExpr) return findBodyAfterParams(masked, namedFnExpr.index);

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
 * in the default export's body with <ClerkProvider>. The last return is the
 * layout's main render — earlier returns are guards like `if (!loaded)
 * return null`. Returns null when no JSX return exists (unsupported shape —
 * the caller falls back to a post-instruction).
 */
export function wrapLastReturnWithProvider(content: string): string | null {
  const masked = maskCommentsAndStrings(content);

  // Fail closed rather than falling back to the whole file: that fallback is
  // how an unresolvable default export ends up with the provider installed in
  // a sibling ErrorBoundary while the real layout stays unwrapped.
  const body = findDefaultExportBody(masked);
  if (!body) return null;
  const { start: from, end: to } = body;

  // Searching the masked region keeps commented-out returns from matching.
  const relIdx = masked.slice(from, to).lastIndexOf("return (");
  if (relIdx !== -1) {
    const openIdx = from + relIdx + "return ".length;
    const closeIdx = findMatchingDelimiter(masked, openIdx, "(", ")");
    if (closeIdx === null) return null;

    const inner = content.slice(openIdx + 1, closeIdx - 1);
    return content.slice(0, openIdx) + wrapJsx(inner) + content.slice(closeIdx);
  }

  // Single-line form: `return <Slot />;` — multi-line JSX without parens is
  // invalid JS (ASI), so the statement always ends on the same line. Matching
  // the masked slice keeps a trailing comment from defeating the greedy
  // `<.*>`; the JSX itself is then read back out of the real content, since
  // any string in it (`<Slot name="x" />`) is blanked in the mask.
  const singleLine = /return\s+(<.*>)\s*;?\s*$/dgm;
  let match: RegExpExecArray | null = null;
  for (const m of masked.slice(from, to).matchAll(singleLine)) match = m;
  if (!match) return null;

  const absIdx = from + match.index;
  const [jsxStart, jsxEnd] = match.indices![1]!;
  const jsx = content.slice(from + jsxStart, from + jsxEnd);

  // Splice only up to the statement's `;`, not to the end of the match: the
  // trailing `\s*$` covers a blanked comment, and consuming it here would
  // delete that comment from the real file.
  const trailing = masked.slice(from + jsxEnd, absIdx + match[0].length);
  const semi = trailing.indexOf(";");
  const spliceEnd = from + jsxEnd + (semi === -1 ? 0 : semi + 1);

  return content.slice(0, absIdx) + `return ${wrapJsx(jsx)};` + content.slice(spliceEnd);
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

  // Masked: a `// TODO: wrap in <ClerkProvider>` left over from a manual
  // attempt would otherwise skip the file with no wiring and no warning.
  if (maskCommentsAndStrings(content).includes("ClerkProvider")) {
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
