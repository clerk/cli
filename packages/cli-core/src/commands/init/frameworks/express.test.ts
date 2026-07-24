import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { express } from "./express.ts";
import type { FileAction, ProjectContext } from "./types.ts";

let tempDir: string;

function makeCtx(overrides?: Partial<ProjectContext>): ProjectContext {
  return {
    cwd: tempDir,
    framework: {
      dep: "express",
      name: "Express",
      sdk: "@clerk/express",
      envVar: "CLERK_PUBLISHABLE_KEY",
      envFile: ".env.local" as const,
    },
    typescript: true,
    srcDir: false,
    packageManager: "npm",
    existingClerk: false,
    deps: { express: "^5.0.0" },
    envFile: ".env",
    ...overrides,
  };
}

function findAction(actions: FileAction[], path: string): FileAction {
  const action = actions.find((a) => a.path === path);
  if (!action) {
    const paths = actions.map((a) => a.path).join(", ");
    throw new Error(`No action found for path "${path}". Available: ${paths}`);
  }
  return action;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "clerk-express-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const ESM_SERVER = `import express from "express";

const app = express();
const PORT = 3000;

app.get("/", (req, res) => {
  res.send("Hello");
});

app.listen(PORT, () => {
  console.log(\`Listening on \${PORT}\`);
});
`;

test("adds clerkMiddleware() after app creation in index.ts", async () => {
  await Bun.write(join(tempDir, "index.ts"), ESM_SERVER);

  const plan = await express.scaffold(makeCtx());

  const entry = findAction(plan.actions, "index.ts");
  expect(entry.type).toBe("modify");
  if (entry.type === "modify") {
    expect(entry.content).toMatch(/import \{\s*clerkMiddleware\s*\} from "@clerk\/express"/);
    expect(entry.content).toContain("app.use(clerkMiddleware());");
    // Middleware attaches right after creation, before any routes
    const middlewareIdx = entry.content.indexOf("app.use(clerkMiddleware())");
    const routeIdx = entry.content.indexOf('app.get("/"');
    expect(middlewareIdx).toBeLessThan(routeIdx);
  }
});

test("finds the entry under src/", async () => {
  await mkdir(join(tempDir, "src"), { recursive: true });
  await Bun.write(join(tempDir, "src/server.ts"), ESM_SERVER);

  const plan = await express.scaffold(makeCtx());

  expect(findAction(plan.actions, "src/server.ts").type).toBe("modify");
});

test("prefers the package.json main entry", async () => {
  await Bun.write(join(tempDir, "package.json"), JSON.stringify({ main: "custom-entry.js" }));
  await Bun.write(join(tempDir, "custom-entry.js"), ESM_SERVER);
  await Bun.write(join(tempDir, "index.js"), ESM_SERVER);

  const plan = await express.scaffold(makeCtx({ typescript: false }));

  expect(findAction(plan.actions, "custom-entry.js").type).toBe("modify");
});

test("ignores a package.json main pointing at build output", async () => {
  await Bun.write(join(tempDir, "package.json"), JSON.stringify({ main: "dist/index.js" }));
  await mkdir(join(tempDir, "dist"), { recursive: true });
  await Bun.write(join(tempDir, "dist/index.js"), ESM_SERVER);
  await Bun.write(join(tempDir, "index.js"), ESM_SERVER);

  const plan = await express.scaffold(makeCtx({ typescript: false }));

  expect(findAction(plan.actions, "index.js").type).toBe("modify");
  expect(plan.actions.some((a) => a.path === "dist/index.js")).toBe(false);
});

test("uses require() style for CommonJS files", async () => {
  await Bun.write(
    join(tempDir, "index.js"),
    `const express = require("express");

const app = express();

app.listen(3000);
`,
  );

  const plan = await express.scaffold(makeCtx({ typescript: false }));

  const entry = findAction(plan.actions, "index.js");
  expect(entry.type).toBe("modify");
  if (entry.type === "modify") {
    expect(entry.content).toContain('const { clerkMiddleware } = require("@clerk/express");');
    expect(entry.content).not.toContain("import {");
    expect(entry.content).toContain("app.use(clerkMiddleware());");
  }
});

test("handles the inline-require creation form", async () => {
  await Bun.write(
    join(tempDir, "index.js"),
    `const app = require("express")();

app.listen(3000);
`,
  );

  const plan = await express.scaffold(makeCtx({ typescript: false }));

  const entry = findAction(plan.actions, "index.js");
  expect(entry.type).toBe("modify");
  if (entry.type === "modify") {
    expect(entry.content).toContain('const { clerkMiddleware } = require("@clerk/express");');
    expect(entry.content).toContain("app.use(clerkMiddleware());");
  }
});

test("ignores a commented-out app creation and attaches to the real one", async () => {
  await Bun.write(
    join(tempDir, "index.ts"),
    `import express from "express";

// Previously: const app = express();
const server = express();

server.get("/", (req, res) => res.send("hi"));
server.listen(3000);
`,
  );

  const plan = await express.scaffold(makeCtx());

  const entry = findAction(plan.actions, "index.ts");
  expect(entry.type).toBe("modify");
  if (entry.type === "modify") {
    expect(entry.content).toContain("server.use(clerkMiddleware());");
    expect(entry.content).not.toContain("app.use(clerkMiddleware());");
    // Attaches after the real creation statement, not after the comment
    const attachIdx = entry.content.indexOf("server.use(clerkMiddleware())");
    const creationIdx = entry.content.indexOf("const server = express();");
    expect(attachIdx).toBeGreaterThan(creationIdx);
  }
});

test("ignores an app creation that only appears inside a string literal", async () => {
  await Bun.write(
    join(tempDir, "index.ts"),
    `const example = "const app = express();";
console.log(example);
`,
  );

  const plan = await express.scaffold(makeCtx());

  expect(findAction(plan.actions, "index.ts").type).toBe("skip");
});

test("scaffolds when the entry imports an unrelated @clerk package", async () => {
  await Bun.write(
    join(tempDir, "index.ts"),
    `import { verifyToken } from "@clerk/backend";
import express from "express";

const app = express();

app.listen(3000);
`,
  );

  const plan = await express.scaffold(makeCtx());

  const entry = findAction(plan.actions, "index.ts");
  expect(entry.type).toBe("modify");
  if (entry.type === "modify") {
    expect(entry.content).toContain("app.use(clerkMiddleware());");
  }
});

test("matches a type-annotated creation statement", async () => {
  await Bun.write(
    join(tempDir, "index.ts"),
    `import express, { type Express } from "express";

const app: Express = express();

app.listen(3000);
`,
  );

  const plan = await express.scaffold(makeCtx());

  const entry = findAction(plan.actions, "index.ts");
  expect(entry.type).toBe("modify");
  if (entry.type === "modify") {
    expect(entry.content).toContain("app.use(clerkMiddleware());");
  }
});

test("adds the ESM import with the codebase's brace spacing", async () => {
  await Bun.write(join(tempDir, "index.ts"), ESM_SERVER);

  const plan = await express.scaffold(makeCtx());

  const entry = findAction(plan.actions, "index.ts");
  if (entry.type === "modify") {
    expect(entry.content).toContain('import { clerkMiddleware } from "@clerk/express"');
  }
});

test("prints the wiring post-instruction when no creation call is found", async () => {
  await Bun.write(join(tempDir, "index.ts"), `console.log("not a server");\n`);

  const plan = await express.scaffold(makeCtx());

  expect(plan.postInstructions.some((i) => i.includes("app.use(clerkMiddleware())"))).toBe(true);
});

test("omits the wiring post-instruction when the entry is already scaffolded", async () => {
  await Bun.write(
    join(tempDir, "index.ts"),
    `import { clerkMiddleware } from "@clerk/express";
import express from "express";
const app = express();
app.use(clerkMiddleware());
`,
  );

  const plan = await express.scaffold(makeCtx());

  expect(plan.postInstructions.some((i) => i.includes("server entry file"))).toBe(false);
});

test("skips when the entry already uses @clerk/express", async () => {
  await Bun.write(
    join(tempDir, "index.ts"),
    `import { clerkMiddleware } from "@clerk/express";
import express from "express";
const app = express();
app.use(clerkMiddleware());
`,
  );

  const plan = await express.scaffold(makeCtx());

  expect(findAction(plan.actions, "index.ts")).toMatchObject({ type: "skip" });
});

test("skips with reason when no express() creation is found", async () => {
  await Bun.write(join(tempDir, "index.ts"), `console.log("not a server");\n`);

  const plan = await express.scaffold(makeCtx());

  const entry = findAction(plan.actions, "index.ts");
  expect(entry.type).toBe("skip");
  if (entry.type === "skip") {
    expect(entry.skipReason).toContain("express");
  }
});

test("creates types/globals.d.ts for TypeScript projects", async () => {
  await Bun.write(join(tempDir, "index.ts"), ESM_SERVER);

  const plan = await express.scaffold(makeCtx());

  const types = findAction(plan.actions, "types/globals.d.ts");
  expect(types.type).toBe("create");
  if (types.type === "create") {
    expect(types.content).toContain('<reference types="@clerk/express/env" />');
  }
});

test("skips the types file when it already exists", async () => {
  await Bun.write(join(tempDir, "index.ts"), ESM_SERVER);
  await Bun.write(join(tempDir, "types/globals.d.ts"), "// existing\n");

  const plan = await express.scaffold(makeCtx());

  expect(findAction(plan.actions, "types/globals.d.ts").type).toBe("skip");
});

test("does not create the types file for JavaScript projects", async () => {
  await Bun.write(join(tempDir, "index.js"), ESM_SERVER);

  const plan = await express.scaffold(makeCtx({ typescript: false }));

  expect(plan.actions.some((a) => a.path === "types/globals.d.ts")).toBe(false);
});

test("prints post-instruction when no entry file exists", async () => {
  const plan = await express.scaffold(makeCtx());

  expect(plan.postInstructions.some((i) => i.includes("clerkMiddleware"))).toBe(true);
});

test("includes env and route-protection post-instructions", async () => {
  await Bun.write(join(tempDir, "index.ts"), ESM_SERVER);

  const plan = await express.scaffold(makeCtx());

  expect(plan.postInstructions.some((i) => i.includes("CLERK_SECRET_KEY"))).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("--env-file"))).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("getAuth"))).toBe(true);
});
