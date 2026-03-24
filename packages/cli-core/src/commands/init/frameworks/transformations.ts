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

/** Wrap the contents of a `<body>` tag with a provider component (e.g. `<ClerkProvider>`). */
export function wrapBodyWithProvider(content: string, provider: string): string {
  const bodyPattern = /^( *)(<body[^>]*>)([\s\S]*?)(<\/body>)/m;
  const match = bodyPattern.exec(content);
  if (!match) return content;

  const [fullMatch, bodyIndent, openTag, inner, closeTag] = match;
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
