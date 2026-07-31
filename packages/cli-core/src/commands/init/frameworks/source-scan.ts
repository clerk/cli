/**
 * Scanning support for the source-code transformations in `transformations.ts`
 * and the framework scaffolders.
 *
 * Scaffolding means finding a place in someone's source file — the last import,
 * the app-creation statement, the layout's return — and inserting code there.
 * Searching raw text finds those anchors inside comments and string literals
 * too, which is how a commented-out `const app = express()` ends up receiving
 * the middleware. Masking removes that whole class of mistake: the returned
 * string has every comment and string *body* replaced with spaces, so a plain
 * `indexOf`/regex over it only ever matches real code.
 *
 * The invariant every caller relies on: the masked string has the same length
 * and the same newline positions as the source, so an index found in the mask
 * can be used directly against the original text.
 */

/**
 * Index of the quote closing the one at `openIdx`, or null when it is unpaired
 * on that line. A JS string literal never contains a raw newline, so a lone
 * quote is punctuation — JSX text (`Don't`) or a quote inside a regex literal
 * (`/"/g`) — and must not be treated as the start of a string.
 */
function findClosingQuoteOnLine(source: string, openIdx: number, quote: string): number | null {
  for (let i = openIdx + 1; i < source.length; i++) {
    const char = source[i]!;
    if (char === "\n") return null;
    if (char === "\\") i++;
    else if (char === quote) return i;
  }
  return null;
}

/**
 * Replace the contents of comments and string/template literals with spaces,
 * preserving length and newlines (delimiters are kept).
 *
 * Template literals get recursive handling: a `${...}` substitution is real
 * code (not masked), and it can itself contain strings, comments, nested
 * template literals, and braces (e.g. an object literal) — so it's scanned
 * with the same code-scanning logic, stopping at the substitution's own
 * closing `}` rather than the first `}` encountered.
 */
export function maskCommentsAndStrings(source: string): string {
  const out = source.split("");
  let i = 0;

  const blank = () => {
    if (source[i] !== "\n") out[i] = " ";
    i++;
  };

  function scanString(quote: string): void {
    const closeIdx = findClosingQuoteOnLine(source, i, quote);
    if (closeIdx === null) {
      i++; // unpaired — punctuation (JSX text, a regex literal), not a string
      return;
    }
    i++; // keep the opening delimiter
    while (i < closeIdx) blank();
    i++; // keep the closing delimiter
  }

  function scanTemplate(): void {
    i++; // keep the opening backtick
    while (i < source.length && source[i] !== "`") {
      if (source[i] === "$" && source[i + 1] === "{") {
        i += 2; // keep `${` — real code, not masked
        scanCode(true);
        if (i < source.length && source[i] === "}") i++; // keep the closing `}`
        continue;
      }
      const escaped = source[i] === "\\";
      blank();
      if (escaped && i < source.length) blank();
    }
    if (i < source.length) i++; // keep the closing backtick
  }

  // Scans real code. When `stopAtOwnBrace` is set (inside a `${...}`
  // substitution), returns as soon as it sees the `}` that closes this
  // substitution — braces opened within it (e.g. `{ a: 1 }`) are tracked so
  // they don't end the substitution early.
  function scanCode(stopAtOwnBrace: boolean): void {
    let braceDepth = 0;
    while (i < source.length) {
      const char = source[i]!;
      const next = source[i + 1];

      if (stopAtOwnBrace && char === "}" && braceDepth === 0) return;

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
      } else if (char === '"' || char === "'") {
        scanString(char);
      } else if (char === "`") {
        scanTemplate();
      } else if (char === "{") {
        braceDepth++;
        i++;
      } else if (char === "}") {
        braceDepth--;
        i++;
      } else {
        i++;
      }
    }
  }

  scanCode(false);
  return out.join("");
}

/**
 * Index just past the delimiter matching the one at `openIdx`, or null when it
 * never closes. Takes masked source so delimiters inside comments, strings, or
 * JSX text don't count toward the depth.
 */
export function findMatchingDelimiter(
  masked: string,
  openIdx: number,
  open: string,
  close: string,
): number | null {
  let depth = 0;

  for (let i = openIdx; i < masked.length; i++) {
    const char = masked[i]!;

    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }

  return null;
}
