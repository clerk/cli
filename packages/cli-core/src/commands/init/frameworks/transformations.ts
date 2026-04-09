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
    return mod.generate().code;
  } catch {
    return `import { ${imported} } from "${source}";\n${content}`;
  }
}

/** Insert a snippet after the last import statement in a source file. */
export function insertAfterLastImport(source: string, snippet: string): string {
  const lastImportIdx = source.lastIndexOf("import ");
  const lineEnd = source.indexOf("\n", lastImportIdx);
  if (lineEnd === -1) return source;
  return source.slice(0, lineEnd + 1) + snippet + source.slice(lineEnd + 1);
}

/**
 * Build the auth header block using HTML attributes (`class` / `style="..."`).
 * Used by Vue, Nuxt, and Astro scaffolders.
 */
export function headerHtmlBlock(indent: string, tailwind: boolean): string {
  const innerIndent = indent + "  ";
  const headerAttr = tailwind
    ? `class="flex h-16 items-center justify-end gap-4 border-b px-4"`
    : `style="display: flex; height: 64px; align-items: center; justify-content: flex-end; gap: 16px; border-bottom: 1px solid #e5e7eb; padding: 0 16px;"`;

  return [
    `${indent}<header ${headerAttr}>`,
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
 * Inject a navigation header with auth buttons inside `<ClerkProvider>`.
 * Must be called AFTER `wrapBodyWithProvider` has already wrapped body contents.
 */
export function injectHeaderInProvider(content: string, tailwind: boolean): string {
  // Match a line containing <ClerkProvider>, capturing leading whitespace for indentation.
  // The provider tag may appear after `return` or other tokens (e.g. React Router).
  const providerPattern = /^( *).*<ClerkProvider[^>]*>/m;
  const match = providerPattern.exec(content);
  if (!match) return content;

  const [, indent] = match;
  const innerIndent = indent + "  ";
  const deepIndent = innerIndent + "  ";

  const headerAttr = tailwind
    ? `className="flex h-16 items-center justify-end gap-4 border-b px-4"`
    : `style={{ display: "flex", height: "64px", alignItems: "center", justifyContent: "flex-end", gap: "16px", borderBottom: "1px solid #e5e7eb", padding: "0 16px" }}`;

  const headerBlock = [
    `${innerIndent}<header ${headerAttr}>`,
    `${deepIndent}<Show when="signed-out">`,
    `${deepIndent}  <SignInButton />`,
    `${deepIndent}  <SignUpButton />`,
    `${deepIndent}</Show>`,
    `${deepIndent}<Show when="signed-in">`,
    `${deepIndent}  <UserButton />`,
    `${deepIndent}</Show>`,
    `${innerIndent}</header>`,
  ].join("\n");

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
  let result = safeAddImport(content, clerkPackage, "Show");
  result = safeAddImport(result, clerkPackage, "SignInButton");
  result = safeAddImport(result, clerkPackage, "SignUpButton");
  result = safeAddImport(result, clerkPackage, "UserButton");
  return injectHeaderInProvider(result, tailwind);
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
