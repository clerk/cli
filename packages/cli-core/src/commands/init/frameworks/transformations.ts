/**
 * Pure text/source-code transformation utilities.
 * These functions take source code as input and return modified source code.
 * Used by framework scaffolders for import injection, provider wrapping, and indentation.
 */
import { parseModule, type ProxifiedModule } from "magicast";
import { maskCommentsAndStrings } from "./source-scan.js";

/**
 * Print a magicast module in the line endings of the source it was parsed from, keeping
 * its trailing line break. magicast's printer joins lines with the host's EOL and drops
 * the final line break, which leaves "No newline at end of file" in the user's diff.
 */
export function printModule(mod: ProxifiedModule, source: string): string {
  const lineTerminator = /\r?\n/.exec(source)?.[0] ?? "\n";
  const code = mod.generate({ lineTerminator }).code;
  const eol = /\r?\n$/.exec(source)?.[0];
  return eol && !code.endsWith("\n") ? code + eol : code;
}

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
    // magicast builds the import node itself and prints it without brace
    // spacing, and no printer option overrides that. Projects without a
    // formatter would keep `import {x}`, so re-space the one statement we
    // added — anchored on `from` so only an import statement can match.
    return printModule(mod, content).replace(
      `import {${imported}} from`,
      `import { ${imported} } from`,
    );
  } catch {
    return `import { ${imported} } from "${source}";\n${content}`;
  }
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

/**
 * How a comment-masked React import binds `Suspense`: as a value, type-only, or not at all.
 * An alias like `Suspense as Pending` binds `Pending`, not `Suspense`.
 */
function suspenseBinding(masked: string): "value" | "type" | undefined {
  const specifiers = (/\{([^}]*)\}/.exec(masked)?.[1] ?? "")
    .split(",")
    .map((specifier) => specifier.trim().replace(/\s+/g, " "));
  if (specifiers.includes("type Suspense")) return "type";
  const named =
    specifiers.includes("Suspense") ||
    specifiers.some((specifier) => /^(?!type\s)\S+\s+as\s+Suspense$/.test(specifier));
  if (!named) return undefined;
  return /^\s*import\s+type\b/.test(masked) ? "type" : "value";
}

/**
 * Make a type-only `Suspense` in a React import a value import. Other specifiers of an
 * `import type { ... }` statement stay type-only through inline `type` modifiers.
 */
function promoteSuspense(statement: string, masked: string): string {
  const modifier = /\btype\s+(?=Suspense\s*[,}])/.exec(masked);
  if (modifier) {
    return (
      statement.slice(0, modifier.index) + statement.slice(modifier.index + modifier[0].length)
    );
  }

  const open = masked.indexOf("{");
  const close = masked.indexOf("}", open);
  const parts: [number, number][] = [];
  let from = open + 1;
  for (let i = from; i <= close; i++) {
    if (masked[i] !== "," && i !== close) continue;
    parts.push([from, i]);
    from = i + 1;
  }

  let result = statement.slice(0, open + 1).replace(/^(\s*import)\s+type\b/, "$1");
  parts.forEach(([partStart, partEnd], index) => {
    const text = statement.slice(partStart, partEnd);
    const name = masked.slice(partStart, partEnd).trim();
    const lead = text.length - text.trimStart().length;
    const prefix = name && name !== "Suspense" ? "type " : "";
    const separator = index < parts.length - 1 ? "," : "";
    result += text.slice(0, lead) + prefix + text.slice(lead) + separator;
  });
  return result + statement.slice(close);
}

/**
 * Make sure a file binds a runtime `Suspense` from React. A type-only `Suspense` import is
 * promoted in place, since a second import of the same name fails with TS2300. Otherwise
 * `import { Suspense } from "react";` goes on its own line after the last import whose
 * module specifier satisfies `isAnchor`, or after the last import when none does.
 */
export function addSuspenseImport(
  source: string,
  isAnchor: (specifier: string) => boolean,
): string {
  const masked = maskCommentsAndStrings(source);
  const imports = [...masked.matchAll(IMPORT_STATEMENT)].map((match) => {
    const start = match.index;
    const end = start + match[0].length;
    const specifier = /["']([^"'\n]*)["'][ \t]*;?$/.exec(source.slice(start, end))?.[1];
    return { start, end, specifier, masked: match[0] };
  });

  const reactImports = imports
    .filter((imp) => imp.specifier === "react")
    .map((imp) => ({ ...imp, binding: suspenseBinding(imp.masked) }));
  if (reactImports.some((imp) => imp.binding === "value")) return source;
  const typeOnly = reactImports.find((imp) => imp.binding === "type");
  if (typeOnly) {
    const statement = promoteSuspense(source.slice(typeOnly.start, typeOnly.end), typeOnly.masked);
    return source.slice(0, typeOnly.start) + statement + source.slice(typeOnly.end);
  }

  const statement = `import { Suspense } from "react";\n`;
  const anchor = imports.findLast((imp) => imp.specifier !== undefined && isAnchor(imp.specifier));
  if (!anchor) return insertAfterLastImport(source, statement);

  const lineEnd = source.indexOf("\n", anchor.end);
  if (lineEnd === -1) return `${source}\n${statement}`;
  return source.slice(0, lineEnd + 1) + statement + source.slice(lineEnd + 1);
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

function buildHeaderBlock(
  indent: string,
  tailwind: boolean,
  syntax: HeaderSyntax,
  suspense = false,
): string {
  const innerIndent = indent + "  ";
  const attrs = HEADER_ATTRS[syntax];
  const attr = tailwind ? attrs.tailwind : attrs.inline;

  const showIndent = suspense ? innerIndent + "  " : innerIndent;
  const showBlocks = [
    `${showIndent}<Show when="signed-out">`,
    `${showIndent}  <SignInButton />`,
    `${showIndent}  <SignUpButton />`,
    `${showIndent}</Show>`,
    `${showIndent}<Show when="signed-in">`,
    `${showIndent}  <UserButton />`,
    `${showIndent}</Show>`,
  ];

  return [
    `${indent}<header ${attr}>`,
    ...(suspense
      ? [`${innerIndent}<Suspense>`, ...showBlocks, `${innerIndent}</Suspense>`]
      : showBlocks),
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
 * `suspense` wraps the `<Show>` blocks in React's `<Suspense>`, which Next.js App Router
 * needs when Cache Components is enabled (`<Show>` reads the request during prerendering).
 * The caller adds the `Suspense` import.
 */
export function injectHeaderInProvider(
  content: string,
  tailwind: boolean,
  options: { suspense?: boolean } = {},
): string {
  const providerPattern = /^( *).*<ClerkProvider[^>]*>/m;
  const match = providerPattern.exec(content);
  if (!match) return content;

  const innerIndent = match[1] + "  ";
  const headerBlock = buildHeaderBlock(innerIndent, tailwind, "jsx", options.suspense ?? false);

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
