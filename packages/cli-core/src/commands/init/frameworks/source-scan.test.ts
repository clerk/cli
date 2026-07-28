import { test, expect, describe } from "bun:test";
import { findMatchingDelimiter, maskCommentsAndStrings } from "./source-scan.ts";

const newlineIndexes = (source: string): number[] =>
  [...source].flatMap((char, idx) => (char === "\n" ? [idx] : []));

describe("maskCommentsAndStrings", () => {
  test("masks string contents but keeps delimiters and length", () => {
    const source = `const a = "hidden";\n`;

    const masked = maskCommentsAndStrings(source);

    expect(masked).toBe(`const a = "      ";\n`);
    expect(masked).toHaveLength(source.length);
  });

  test("masks line and block comments", () => {
    const source = `// secret\nconst a = 1;\n/* more */\n`;

    const masked = maskCommentsAndStrings(source);

    expect(masked).toContain("const a = 1;");
    expect(masked).not.toContain("secret");
    expect(masked).not.toContain("more");
  });

  // An unpaired quote must not swallow the rest of the file: real JS strings
  // never span lines, so a lone quote is punctuation (JSX text, a regex).
  test.each([
    ["apostrophe in JSX text", `<Text>Don't panic</Text>\nconst app = express();\n`],
    ["quote inside a regex literal", `const s = t.replace(/"/g, "");\nconst app = express();\n`],
    ["apostrophe inside a regex literal", `const re = /don't/;\nconst app = express();\n`],
  ])("keeps code visible after %s", (_name, source) => {
    expect(maskCommentsAndStrings(source)).toContain("const app = express();");
  });

  test("still masks multi-line template literals", () => {
    const source = "const t = `line one\nline two`;\nconst app = x();\n";

    const masked = maskCommentsAndStrings(source);

    expect(masked).not.toContain("line one");
    expect(masked).toContain("const app = x();");
  });
});

// The invariant every scaffolder relies on: an index found in the mask is
// usable verbatim against the original source. That only holds if masking
// never changes the length or moves a newline.
describe("maskCommentsAndStrings — index invariant", () => {
  test.each([
    ["a plain string", `const a = "hidden";\n`],
    ["an escaped quote inside a string", `const a = "he said \\"hi\\"";\n`],
    ["a line comment", `// note\nconst a = 1;\n`],
    ["a block comment spanning lines", `/* one\n   two */\nconst a = 1;\n`],
    ["an unterminated block comment", `/* open\nconst a = 1;\n`],
    ["a multi-line template literal", "const t = `one\ntwo`;\n"],
    ["a template substitution", "const t = `a ${b.c} d`;\n"],
    ["a nested template substitution", "const t = `a ${`b ${c} d`} e`;\n"],
    ["an unterminated template literal", "const t = `open\nconst a = 1;\n"],
    ["an unpaired quote", `<Text>Don't panic</Text>\n`],
    ["a file with no trailing newline", `const a = "x";`],
    ["an empty file", ""],
  ])("preserves length and newline positions with %s", (_name, source) => {
    const masked = maskCommentsAndStrings(source);

    expect(masked).toHaveLength(source.length);
    expect(newlineIndexes(masked)).toEqual(newlineIndexes(source));
  });

  test("an index found in the mask points at the same code in the source", () => {
    const source = [
      `// const app = express();`,
      `const banner = "const app = express();";`,
      `const app = express();`,
      ``,
    ].join("\n");

    const masked = maskCommentsAndStrings(source);
    const idx = masked.indexOf("const app = express();");

    // The commented-out and quoted copies are blanked, so the only hit is the
    // real statement — and the mask index lands on it in the original text.
    expect(idx).toBeGreaterThan(-1);
    expect(source.slice(idx, idx + "const app = express();".length)).toBe("const app = express();");
    expect(source.lastIndexOf("const app = express();")).toBe(idx);
  });
});

describe("maskCommentsAndStrings — strings", () => {
  test.each([
    {
      name: "an escaped quote does not end the string early",
      source: `const a = "he said \\"hi\\"";\nconst app = express();\n`,
      mustNotContain: "he said",
    },
    {
      name: "a `//` inside a string does not start a comment",
      source: `const u = "http://x.com";\nconst app = express();\n`,
      mustNotContain: "x.com",
    },
    {
      name: "comment markers inside a string are inert",
      source: `const a = "/* nope */";\nconst app = express();\n`,
      mustNotContain: "nope",
    },
    {
      name: "a foreign quote inside a string does not open a new string",
      source: `const a = "don't";\nconst app = express();\n`,
      mustNotContain: "don't",
    },
    {
      name: "a backtick inside a quoted string does not open a template",
      source: 'const a = "`";\nconst app = express();\n',
      mustNotContain: "`",
    },
  ])("$name", ({ source, mustNotContain }) => {
    const masked = maskCommentsAndStrings(source);

    expect(masked).not.toContain(mustNotContain);
    expect(masked).toContain("const app = express();");
  });

  // Left visible rather than masked to EOF: an unpaired quote is punctuation,
  // and a file that ends mid-line has no newline to prove otherwise.
  test("leaves an unterminated string at EOF untouched", () => {
    const source = `const a = "open`;

    expect(maskCommentsAndStrings(source)).toBe(source);
  });
});

describe("maskCommentsAndStrings — comments", () => {
  test.each([
    {
      name: "an unpaired apostrophe in a line comment",
      source: `// don't do this\nconst app = express();\n`,
      mustNotContain: "do this",
    },
    {
      name: "an unpaired apostrophe in a block comment",
      source: `/* don't */\nconst app = express();\n`,
      mustNotContain: "don't",
    },
    {
      name: "a quote in a block comment spanning lines",
      source: `/* it's\n   fine */\nconst app = express();\n`,
      mustNotContain: "fine",
    },
    {
      name: "a backtick in a line comment",
      source: "// use `app`\nconst app = express();\n",
      mustNotContain: "use",
    },
  ])("keeps code visible after $name", ({ source, mustNotContain }) => {
    const masked = maskCommentsAndStrings(source);

    expect(masked).not.toContain(mustNotContain);
    expect(masked).toContain("const app = express();");
  });

  // Failing closed: everything after an unterminated `/*` is blanked, so no
  // anchor can match inside what the file itself never reopened as code.
  test("masks an unterminated block comment through to EOF", () => {
    const source = `/* open\nconst app = express();\n`;

    const masked = maskCommentsAndStrings(source);

    expect(masked).not.toContain("express");
    expect(masked.trim()).toBe("");
  });
});

describe("maskCommentsAndStrings — template substitutions", () => {
  test.each([
    {
      name: "blanks the literal text inside a nested template substitution",
      source: "const a = `outer ${`inner`} end`;\nconst REAL_CODE = 1;\n",
      mustNotContain: "inner",
      mustContain: "REAL_CODE",
    },
    {
      name: "keeps an object literal's braces from ending the substitution early",
      source: "const a = `x ${({ b: 1 }).b} y`;\nconst REAL_CODE = 1;\n",
      mustNotContain: "x ${",
      mustContain: "({ b: 1 }).b",
    },
    {
      name: "handles a string literal inside a substitution",
      source: 'const a = `x ${"}"} y`;\nconst REAL_CODE = 1;\n',
      mustNotContain: '"}"',
      mustContain: "REAL_CODE",
    },
    {
      name: "handles a comment inside a substitution",
      source: "const a = `x ${/* } */ 1} y`;\nconst REAL_CODE = 1;\n",
      mustNotContain: "} */",
      mustContain: "REAL_CODE",
    },
    {
      name: "keeps a substitution nested inside another substitution as code",
      source: "const a = `x ${`y ${inner} z`} w`;\nconst REAL_CODE = 1;\n",
      mustNotContain: "y ${",
      mustContain: "${inner}",
    },
    {
      name: "handles an empty substitution",
      source: "const a = `x ${} y`;\nconst REAL_CODE = 1;\n",
      mustNotContain: "x ${",
      mustContain: "REAL_CODE",
    },
    {
      name: "an escaped backtick does not close the template",
      source: "const a = `x \\` y`;\nconst REAL_CODE = 1;\n",
      mustNotContain: "x \\`",
      mustContain: "REAL_CODE",
    },
    {
      name: "a `${` inside a substitution's own string does not nest",
      source: 'const a = `x ${"${"} y`;\nconst REAL_CODE = 1;\n',
      mustNotContain: '"${"',
      mustContain: "REAL_CODE",
    },
  ])("$name", ({ source, mustNotContain, mustContain }) => {
    const masked = maskCommentsAndStrings(source);

    expect(masked).not.toContain(mustNotContain);
    expect(masked).toContain(mustContain);
    expect(masked.length).toBe(source.length);
  });

  test("masks an unterminated template literal through to EOF", () => {
    const source = "const t = `open\nconst app = express();\n";

    const masked = maskCommentsAndStrings(source);

    expect(masked).toContain("const t = `");
    expect(masked).not.toContain("express");
  });
});

describe("findMatchingDelimiter", () => {
  test.each([
    { name: "a simple pair", input: "(a)b", open: "(", close: ")", expected: 3 },
    { name: "a nested pair", input: "(a(b))c", open: "(", close: ")", expected: 6 },
    { name: "braces", input: "{ a: { b: 1 } }", open: "{", close: "}", expected: 15 },
    { name: "an empty pair", input: "()", open: "(", close: ")", expected: 2 },
  ])("returns the index just past the close for $name", ({ input, open, close, expected }) => {
    expect(findMatchingDelimiter(input, 0, open, close)).toBe(expected);

    // "just past" — slicing with it yields the whole balanced span.
    expect(input.slice(0, expected).endsWith(close)).toBe(true);
  });

  test("starts from an inner delimiter when given its index", () => {
    const input = "(a(b)c)";

    expect(findMatchingDelimiter(input, 2, "(", ")")).toBe(5);
  });

  test.each([
    { name: "the delimiter never closes", input: "(a(b)", openIdx: 0 },
    { name: "there is no delimiter at all", input: "no delim here", openIdx: 0 },
    { name: "openIdx does not point at an open delimiter", input: "a)b(c)", openIdx: 0 },
  ])("returns null when $name", ({ input, openIdx }) => {
    expect(findMatchingDelimiter(input, openIdx, "(", ")")).toBeNull();
  });

  // The `masked` parameter is not a convention — it is required for
  // correctness. A delimiter inside a string body inflates the depth and the
  // scan walks off the end of the real span.
  test("only balances correctly on masked source", () => {
    const source = `foo("(", bar);`;

    expect(findMatchingDelimiter(source, 3, "(", ")")).toBeNull();
    expect(findMatchingDelimiter(maskCommentsAndStrings(source), 3, "(", ")")).toBe(
      source.length - 1,
    );
  });

  test("ignores a delimiter that only appears in a comment", () => {
    const source = `fn(a /* ) */, b);`;

    const end = findMatchingDelimiter(maskCommentsAndStrings(source), 2, "(", ")");

    expect(end).not.toBeNull();
    expect(source.slice(2, end!)).toBe("(a /* ) */, b)");
  });
});
