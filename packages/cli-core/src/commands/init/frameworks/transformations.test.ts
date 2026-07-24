import { test, expect, describe } from "bun:test";
import { insertAfterLastImport, maskCommentsAndStrings } from "./transformations.ts";

describe("insertAfterLastImport", () => {
  test("inserts after a single-line import", () => {
    const source = `import { a } from "a";\nconst x = 1;\n`;

    const result = insertAfterLastImport(source, "SNIPPET\n");

    expect(result).toBe(`import { a } from "a";\nSNIPPET\nconst x = 1;\n`);
  });

  test("inserts after the end of a multi-line import statement", () => {
    const source = `import { Slot } from "expo-router";
import {
  useFonts,
} from "expo-font";

export default function RootLayout() {}
`;

    const result = insertAfterLastImport(source, "\nconst key = 1;\n");

    // The import statement survives intact…
    expect(result).toContain('import {\n  useFonts,\n} from "expo-font";');
    // …and the snippet lands after it, not between its braces
    expect(result.indexOf("const key = 1;")).toBeGreaterThan(result.indexOf('} from "expo-font";'));
  });

  test("inserts after a trailing side-effect import", () => {
    const source = `import { a } from "a";\nimport "./polyfills";\nconst x = 1;\n`;

    const result = insertAfterLastImport(source, "SNIPPET\n");

    expect(result.indexOf("SNIPPET")).toBeGreaterThan(result.indexOf('"./polyfills"'));
    expect(result.indexOf("SNIPPET")).toBeLessThan(result.indexOf("const x = 1;"));
  });

  test("ignores the word import inside a comment", () => {
    const source = `import { a } from "a";
// import { b } from "b"; (removed)
const x = 1;
`;

    const result = insertAfterLastImport(source, "SNIPPET\n");

    expect(result.indexOf("SNIPPET")).toBeLessThan(result.indexOf("// import"));
  });
});

describe("maskCommentsAndStrings", () => {
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
