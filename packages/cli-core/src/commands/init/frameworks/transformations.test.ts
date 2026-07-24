import { test, expect, describe } from "bun:test";
import { insertAfterLastImport } from "./transformations.ts";

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
