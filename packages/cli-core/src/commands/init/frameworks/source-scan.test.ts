import { test, expect, describe } from "bun:test";
import { maskCommentsAndStrings } from "./source-scan.ts";

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
  ])("$name", ({ source, mustNotContain, mustContain }) => {
    const masked = maskCommentsAndStrings(source);

    expect(masked).not.toContain(mustNotContain);
    expect(masked).toContain(mustContain);
    expect(masked.length).toBe(source.length);
  });
});
