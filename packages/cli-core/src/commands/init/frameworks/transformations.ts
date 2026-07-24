/**
 * Pure text/source-code transformation utilities.
 * These functions take source code as input and return modified source code.
 * Used by framework scaffolders for import injection, provider wrapping, and indentation.
 */
import { parseModule } from "magicast";

/** Check if file content already imports from a @clerk/ package. */
export function hasClerkImport(content: string): boolean {
  return content.includes("@clerk/");
}

export function indentBlock(content: string, indent: string): string {
  return content
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

/**
 * Add an import to a file using magicast AST, with a string-prepend fallback.
 * Returns the modified source code.
 */
export function safeAddImport(content: string, source: string, imported: string): string {
  try {
    const mod = parseModule(content);
    mod.imports.$add({ from: source, imported, local: imported });
    // magicast prints new imports without brace spacing — align the added
    // line with this codebase's (and Prettier's) `import { x }` style.
    return mod.generate().code.replace(`import {${imported}}`, `import { ${imported} }`);
  } catch {
    return `import { ${imported} } from "${source}";\n${content}`;
  }
}

/**
 * Replace the contents of comments and string/template literals with spaces,
 * preserving length and newlines (delimiters are kept). Searches over the
 * result only match real code, and every index maps 1:1 back to the source.
 */
export function maskCommentsAndStrings(source: string): string {
  const out = source.split("");
  let i = 0;

  const blank = () => {
    if (source[i] !== "\n") out[i] = " ";
    i++;
  };

  while (i < source.length) {
    const char = source[i]!;
    const next = source[i + 1];

    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") blank();
    } else if (char === "/" && next === "*") {
      blank();
      blank();
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) blank();
      if (i < source.length) {
        blank();
        blank();
      }
    } else if (char === '"' || char === "'" || char === "`") {
      i++; // keep the opening delimiter
      while (i < source.length && source[i] !== char) {
        const escaped = source[i] === "\\";
        blank();
        if (escaped && i < source.length) blank();
      }
      i++; // keep the closing delimiter
    } else {
      i++;
    }
  }

  return out.join("");
}

// Spans a complete import statement, including multi-line named-import blocks
// and side-effect imports (`import "./x"`), through its module specifier.
const IMPORT_STATEMENT = /^[ \t]*import\b(?:[\s\S]*?from)?\s*["'][^"'\n]*["'][ \t]*;?/gm;

/** Insert a snippet after the last import statement in a source file. */
export function insertAfterLastImport(source: string, snippet: string): string {
  // Match against masked source so `import` inside comments/strings can't
  // hijack the insertion point, and multi-line imports are spanned fully.
  let last: RegExpExecArray | null = null;
  for (const match of maskCommentsAndStrings(source).matchAll(IMPORT_STATEMENT)) last = match;
  if (!last) return snippet + source;

  const lineEnd = source.indexOf("\n", last.index + last[0].length);
  if (lineEnd === -1) return `${source}\n${snippet}`;
  return source.slice(0, lineEnd + 1) + snippet + source.slice(lineEnd + 1);
}

type HeaderSyntax = "html" | "jsx";

const HEADER_ATTRS: Record<HeaderSyntax, { tailwind: string; inline: string }> = {
  html: {
    tailwind: `class="flex h-16 items-center justify-end gap-4 border-b px-4"`,
    inline: `style="display: flex; height: 64px; align-items: center; justify-content: flex-end; gap: 16px; border-bottom: 1px solid #e5e7eb; padding: 0 16px;"`,
  },
  jsx: {
    tailwind: `className="flex h-16 items-center justify-end gap-4 border-b px-4"`,
    inline: `style={{ display: "flex", height: "64px", alignItems: "center", justifyContent: "flex-end", gap: "16px", borderBottom: "1px solid #e5e7eb", padding: "0 16px" }}`,
  },
};

const AUTH_HEADER_COMPONENTS = ["Show", "SignInButton", "SignUpButton", "UserButton"] as const;

function buildHeaderBlock(indent: string, tailwind: boolean, syntax: HeaderSyntax): string {
  const innerIndent = indent + "  ";
  const attrs = HEADER_ATTRS[syntax];
  const attr = tailwind ? attrs.tailwind : attrs.inline;

  return [
    `${indent}<header ${attr}>`,
    `${innerIndent}<Show when="signed-out">`,
    `${innerIndent}  <SignInButton />`,
    `${innerIndent}  <SignUpButton />`,
    `${innerIndent}</Show>`,
    `${innerIndent}<Show when="signed-in">`,
    `${innerIndent}  <UserButton />`,
    `${innerIndent}</Show>`,
    `${indent}</header>`,
  ].join("\n");
}

/**
 * Build the auth header block using HTML attributes (`class` / `style="..."`).
 * Used by Vue, Nuxt, and Astro scaffolders.
 */
export function headerHtmlBlock(indent: string, tailwind: boolean): string {
  return buildHeaderBlock(indent, tailwind, "html");
}

/**
 * Inject a navigation header with auth buttons inside `<ClerkProvider>`.
 * Must be called AFTER `wrapBodyWithProvider` has already wrapped body contents.
 */
export function injectHeaderInProvider(content: string, tailwind: boolean): string {
  const providerPattern = /^( *).*<ClerkProvider[^>]*>/m;
  const match = providerPattern.exec(content);
  if (!match) return content;

  const innerIndent = match[1] + "  ";
  const headerBlock = buildHeaderBlock(innerIndent, tailwind, "jsx");

  return content.replace(providerPattern, (fullMatch) => `${fullMatch}\n${headerBlock}`);
}

/**
 * Add Show, SignInButton, SignUpButton, UserButton imports from a Clerk package
 * and inject a header inside <ClerkProvider>. Used by JSX frameworks during bootstrap.
 */
export function addBootstrapHeader(
  content: string,
  clerkPackage: string,
  tailwind: boolean,
): string {
  const withImports = AUTH_HEADER_COMPONENTS.reduce(
    (result, name) => safeAddImport(result, clerkPackage, name),
    content,
  );
  return injectHeaderInProvider(withImports, tailwind);
}

/** Wrap the contents of a `<body>` tag with a provider component (e.g. `<ClerkProvider>`). */
export function wrapBodyWithProvider(content: string, provider: string): string {
  const bodyPattern = /^( *)(<body[^>]*>)([\s\S]*?)(<\/body>)/m;
  const match = bodyPattern.exec(content);
  if (!match) return content;

  const [fullMatch, bodyIndent = "", openTag, inner = "", closeTag] = match;
  const providerIndent = bodyIndent + "  ";
  const contentIndent = providerIndent + "  ";

  const trimmedInner = inner.trim();
  const reindented = trimmedInner
    .split("\n")
    .map((line) => {
      const stripped = line.trimStart();
      return stripped ? `${contentIndent}${stripped}` : "";
    })
    .join("\n");

  const wrapped = [
    `${bodyIndent}${openTag}`,
    `${providerIndent}<${provider}>`,
    reindented,
    `${providerIndent}</${provider}>`,
    `${bodyIndent}${closeTag}`,
  ].join("\n");

  return content.replace(fullMatch!, wrapped);
}
