import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fastify } from "./fastify.ts";
import type { FileAction, ProjectContext } from "./types.ts";

let tempDir: string;

function makeCtx(overrides?: Partial<ProjectContext>): ProjectContext {
  return {
    cwd: tempDir,
    framework: {
      dep: "fastify",
      name: "Fastify",
      sdk: "@clerk/fastify",
      envVar: "CLERK_PUBLISHABLE_KEY",
      envFile: ".env.local" as const,
    },
    typescript: true,
    srcDir: false,
    packageManager: "npm",
    existingClerk: false,
    deps: { fastify: "^5.0.0" },
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
  tempDir = await mkdtemp(join(tmpdir(), "clerk-fastify-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("ignores a block-commented creation and registers on the real instance", async () => {
  await Bun.write(
    join(tempDir, "index.ts"),
    `import Fastify from "fastify";

/* const app = Fastify(); */
const server = Fastify();

server.listen({ port: 3000 });
`,
  );

  const plan = await fastify.scaffold(makeCtx());

  const entry = findAction(plan.actions, "index.ts");
  expect(entry.type).toBe("modify");
  if (entry.type === "modify") {
    expect(entry.content).toContain("server.register(clerkPlugin);");
    expect(entry.content).not.toContain("app.register(clerkPlugin);");
  }
});

test("matches a type-annotated creation statement", async () => {
  await Bun.write(
    join(tempDir, "index.ts"),
    `import Fastify, { type FastifyInstance } from "fastify";

const server: FastifyInstance = Fastify();

server.listen({ port: 3000 });
`,
  );

  const plan = await fastify.scaffold(makeCtx());

  const entry = findAction(plan.actions, "index.ts");
  expect(entry.type).toBe("modify");
  if (entry.type === "modify") {
    expect(entry.content).toContain("server.register(clerkPlugin);");
  }
});

test("prints the wiring post-instruction when no creation call is found", async () => {
  await Bun.write(join(tempDir, "index.ts"), `console.log("not a server");\n`);

  const plan = await fastify.scaffold(makeCtx());

  expect(plan.postInstructions.some((i) => i.includes("Register `clerkPlugin`"))).toBe(true);
});

test("registers clerkPlugin after a multi-line Fastify() creation", async () => {
  await Bun.write(
    join(tempDir, "index.ts"),
    `import Fastify from "fastify";

const fastify = Fastify({
  logger: true,
});

fastify.get("/", async () => ({ hello: "world" }));

await fastify.listen({ port: 8080 });
`,
  );

  const plan = await fastify.scaffold(makeCtx());

  const entry = findAction(plan.actions, "index.ts");
  expect(entry.type).toBe("modify");
  if (entry.type === "modify") {
    expect(entry.content).toMatch(/import \{\s*clerkPlugin\s*\} from "@clerk\/fastify"/);
    expect(entry.content).toContain("fastify.register(clerkPlugin);");
    // Injection lands after the full creation statement, not inside the options object
    expect(entry.content).toContain("logger: true,\n});\nfastify.register(clerkPlugin);");
  }
});

test("handles the lowercase fastify() factory and custom variable name", async () => {
  await Bun.write(
    join(tempDir, "server.ts"),
    `import fastifyFactory from "fastify";
const server = fastifyFactory();
`,
  );
  // The factory regex matches `fastify(` / `Fastify(` — a renamed import is not matched.
  await Bun.write(
    join(tempDir, "index.ts"),
    `import fastify from "fastify";
const server = fastify({ logger: true });
await server.listen({ port: 3000 });
`,
  );

  const plan = await fastify.scaffold(makeCtx());

  const entry = findAction(plan.actions, "index.ts");
  expect(entry.type).toBe("modify");
  if (entry.type === "modify") {
    expect(entry.content).toContain("server.register(clerkPlugin);");
  }
});

test("injects after a chained withTypeProvider() call", async () => {
  await Bun.write(
    join(tempDir, "index.ts"),
    `import Fastify from "fastify";

const app = Fastify({
  logger: true,
}).withTypeProvider();

app.listen({ port: 8080 });
`,
  );

  const plan = await fastify.scaffold(makeCtx());

  const entry = findAction(plan.actions, "index.ts");
  expect(entry.type).toBe("modify");
  if (entry.type === "modify") {
    expect(entry.content).toContain(".withTypeProvider();\napp.register(clerkPlugin);");
  }
});

test("handles the multi-line inline-require creation form without splitting the statement", async () => {
  await Bun.write(
    join(tempDir, "index.js"),
    `const fastify = require("fastify")({
  logger: true,
});

fastify.listen({ port: 8080 });
`,
  );

  const plan = await fastify.scaffold(makeCtx({ typescript: false }));

  const entry = findAction(plan.actions, "index.js");
  expect(entry.type).toBe("modify");
  if (entry.type === "modify") {
    expect(entry.content).toContain(
      '});\nconst { clerkPlugin } = require("@clerk/fastify");\nfastify.register(clerkPlugin);',
    );
  }
});

test("skips when the entry already uses @clerk/fastify", async () => {
  await Bun.write(
    join(tempDir, "index.ts"),
    `import { clerkPlugin } from "@clerk/fastify";
import Fastify from "fastify";
const fastify = Fastify();
fastify.register(clerkPlugin);
`,
  );

  const plan = await fastify.scaffold(makeCtx());

  expect(findAction(plan.actions, "index.ts")).toMatchObject({ type: "skip" });
});

test("skips with reason when no Fastify() creation is found", async () => {
  await Bun.write(join(tempDir, "index.ts"), `console.log("not a server");\n`);

  const plan = await fastify.scaffold(makeCtx());

  expect(findAction(plan.actions, "index.ts").type).toBe("skip");
});

test("prints post-instruction when no entry file exists", async () => {
  const plan = await fastify.scaffold(makeCtx());

  expect(plan.actions).toHaveLength(0);
  expect(plan.postInstructions.some((i) => i.includes("clerkPlugin"))).toBe(true);
});

test("includes env and route-protection post-instructions", async () => {
  const plan = await fastify.scaffold(makeCtx());

  expect(plan.postInstructions.some((i) => i.includes("CLERK_SECRET_KEY"))).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("getAuth"))).toBe(true);
});
