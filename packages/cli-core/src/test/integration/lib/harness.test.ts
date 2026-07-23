import { test, expect } from "bun:test";
import { join } from "node:path";
import { API } from "typescript/unstable/async";
import {
  SyntaxKind,
  isArrowFunction,
  isAwaitExpression,
  isCallExpression,
  isConstructorDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isMethodDeclaration,
  isStringLiteral,
  type CallExpression,
  type Node,
} from "typescript/unstable/ast";

const CONFIG_MODULE_PATH = "../../../lib/config.ts";

function isFunctionBoundary(node: Node): boolean {
  return (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isArrowFunction(node) ||
    isMethodDeclaration(node) ||
    isConstructorDeclaration(node)
  );
}

function isConfigImportExpression(node: Node): node is CallExpression {
  if (!isCallExpression(node) || node.expression.kind !== SyntaxKind.ImportKeyword) return false;

  const [path] = node.arguments;

  return (
    node.arguments.length === 1 &&
    path !== undefined &&
    isStringLiteral(path) &&
    path.text === CONFIG_MODULE_PATH
  );
}

function containsTopLevelAwaitedConfigImport(node: Node): boolean {
  if (isFunctionBoundary(node)) return false;
  if (isAwaitExpression(node) && isConfigImportExpression(node.expression)) return true;

  return node.forEachChild(containsTopLevelAwaitedConfigImport) ?? false;
}

test("integration harness does not top-level await config imports", async () => {
  const fileName = join(import.meta.dir, "harness.ts");
  const api = new API();

  try {
    const snapshot = await api.updateSnapshot({ openFiles: [fileName] });
    const project = await snapshot.getDefaultProjectForFile(fileName);
    const sourceFile = await project?.program.getSourceFile(fileName);

    expect(sourceFile).toBeDefined();
    expect(sourceFile!.statements.some(containsTopLevelAwaitedConfigImport)).toBe(false);

    await snapshot.dispose();
  } finally {
    await api.close();
  }
});
