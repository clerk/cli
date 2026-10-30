import { test, expect, describe } from "bun:test";
import { parseModule } from "magicast";
import {
  addSuspenseImport,
  insertAfterLastImport,
  printModule,
  safeAddImport,
} from "./transformations.ts";

describe("printModule", () => {
  test.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("keeps the source's trailing %s line break", (_name, eol) => {
    const source = `export default {${eol}  a: 1,${eol}};${eol}`;
    const mod = parseModule(source);
    mod.exports.default.b = 2;

    const result = printModule(mod, source);

    expect(result.endsWith(`;${eol}`)).toBe(true);
  });

  test("adds no line break when the source ended without one", () => {
    const source = `export default {\n  a: 1,\n};`;
    const mod = parseModule(source);
    mod.exports.default.b = 2;

    expect(printModule(mod, source).endsWith(";")).toBe(true);
  });
});

describe("safeAddImport", () => {
  test("keeps the trailing newline", () => {
    const source = `import "./globals.css";\n\nexport default function RootLayout() {\n  return null;\n}\n`;

    const result = safeAddImport(source, "@clerk/nextjs", "ClerkProvider");

    expect(result).toContain('import { ClerkProvider } from "@clerk/nextjs";');
    expect(result.endsWith("}\n")).toBe(true);
  });
});

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

describe("addSuspenseImport", () => {
  const isClerk = (specifier: string) => specifier === "@clerk/nextjs";

  test("inserts after the last anchor import", () => {
    const source = `import { ClerkProvider } from "@clerk/nextjs";\nimport "./globals.css";\n`;

    const result = addSuspenseImport(source, isClerk);

    expect(result).toBe(
      `import { ClerkProvider } from "@clerk/nextjs";\nimport { Suspense } from "react";\nimport "./globals.css";\n`,
    );
  });

  test("ignores a subpath of the anchor package", () => {
    const source = `import { auth } from "@clerk/nextjs/server";\nimport { a } from "a";\nconst x = 1;\n`;

    const result = addSuspenseImport(source, isClerk);

    expect(result).toBe(
      `import { auth } from "@clerk/nextjs/server";\nimport { a } from "a";\nimport { Suspense } from "react";\nconst x = 1;\n`,
    );
  });

  test("leaves a file that already imports Suspense unchanged", () => {
    const source = `import { ClerkProvider } from "@clerk/nextjs";\nimport { Suspense, type ReactNode } from 'react';\n`;

    expect(addSuspenseImport(source, isClerk)).toBe(source);
  });

  test("leaves a commented Suspense import unchanged", () => {
    const source = `import { ClerkProvider } from "@clerk/nextjs";\nimport { /* layout */ Suspense } from "react";\n`;

    expect(addSuspenseImport(source, isClerk)).toBe(source);
  });

  test.each([
    [`import type { Suspense } from "react";`, `import { Suspense } from "react";`],
    [`import { type Suspense } from "react";`, `import { Suspense } from "react";`],
    [`import { type  Suspense } from "react";`, `import { Suspense } from "react";`],
    [`import {\n  type\n  Suspense,\n} from "react";`, `import {\n  Suspense,\n} from "react";`],
    [
      `import type { ReactNode, Suspense } from "react";`,
      `import { type ReactNode, Suspense } from "react";`,
    ],
    [
      `import { type ReactNode, type Suspense } from "react";`,
      `import { type ReactNode, Suspense } from "react";`,
    ],
  ])("promotes %s to a value import instead of adding a duplicate", (reactImport, promoted) => {
    const source = `import { ClerkProvider } from "@clerk/nextjs";\n${reactImport}\n`;

    expect(addSuspenseImport(source, isClerk)).toBe(
      `import { ClerkProvider } from "@clerk/nextjs";\n${promoted}\n`,
    );
  });

  test.each([
    `import { Suspense as Pending } from "react";`,
    `import type { Suspense as SuspenseProps } from "react";`,
    `import { type\nSuspense as SuspenseProps } from "react";`,
  ])("adds the import when %s aliases Suspense away", (reactImport) => {
    const source = `import { ClerkProvider } from "@clerk/nextjs";\n${reactImport}\n`;

    expect(addSuspenseImport(source, isClerk)).toBe(
      `import { ClerkProvider } from "@clerk/nextjs";\nimport { Suspense } from "react";\n${reactImport}\n`,
    );
  });
});
