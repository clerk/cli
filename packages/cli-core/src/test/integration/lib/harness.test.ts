import { test, expect } from "bun:test";
import { join } from "node:path";
import ts from "typescript";

const CONFIG_MODULE_PATH = "../../../lib/config.ts";

function isFunctionBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function isConfigImportExpression(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword)
    return false;

  const [path] = node.arguments;

  return (
    node.arguments.length === 1 &&
    path !== undefined &&
    ts.isStringLiteralLike(path) &&
    path.text === CONFIG_MODULE_PATH
  );
}

function containsTopLevelAwaitedConfigImport(node: ts.Node): boolean {
  if (isFunctionBoundary(node)) return false;
  if (ts.isAwaitExpression(node) && isConfigImportExpression(node.expression)) return true;

  return ts.forEachChild(node, containsTopLevelAwaitedConfigImport) ?? false;
}

test("integration harness does not top-level await config imports", async () => {
  const source = await Bun.file(join(import.meta.dir, "harness.ts")).text();
  const sourceFile = ts.createSourceFile("harness.ts", source, ts.ScriptTarget.Latest, true);

  expect(sourceFile.statements.some(containsTopLevelAwaitedConfigImport)).toBe(false);
});
