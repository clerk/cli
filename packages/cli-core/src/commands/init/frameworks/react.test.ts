import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { reactVite } from "./react.ts";
import type { FileAction, ProjectContext } from "./types.ts";

let tempDir: string;

function makeCtx(overrides?: Partial<ProjectContext>): ProjectContext {
  return {
    cwd: tempDir,
    framework: {
      dep: "react",
      name: "React",
      sdk: "@clerk/react",
      envVar: "VITE_CLERK_PUBLISHABLE_KEY",
      envFile: ".env.local",
    },
    typescript: true,
    srcDir: true,
    packageManager: "npm",
    existingClerk: false,
    deps: {},
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
  tempDir = await mkdtemp(join(tmpdir(), "clerk-react-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("wraps inside StrictMode when present", async () => {
  await mkdir(join(tempDir, "src"), { recursive: true });
  await Bun.write(
    join(tempDir, "src/main.tsx"),
    `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
  );

  const plan = await reactVite.scaffold(makeCtx());

  const entry = findAction(plan.actions, "src/main.tsx");
  expect(entry.type).toBe("modify");
  if (entry.type === "modify") {
    expect(entry.content).toContain("ClerkProvider");
    expect(entry.content).toContain("@clerk/react");
    expect(entry.content).toContain('afterSignOutUrl="/"');
    expect(entry.content).toContain("</ClerkProvider>");
    expect(entry.content).toContain("StrictMode");
  }
});

test("wraps App when no StrictMode present", async () => {
  await mkdir(join(tempDir, "src"), { recursive: true });
  await Bun.write(
    join(tempDir, "src/main.tsx"),
    `import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
`,
  );

  const plan = await reactVite.scaffold(makeCtx());

  const entry = findAction(plan.actions, "src/main.tsx");
  expect(entry.type).toBe("modify");
  if (entry.type === "modify") {
    expect(entry.content).toContain('<ClerkProvider afterSignOutUrl="/">');
    expect(entry.content).toContain("<App />");
    expect(entry.content).not.toContain("StrictMode");
  }
});

test("skips when entry already has ClerkProvider", async () => {
  await mkdir(join(tempDir, "src"), { recursive: true });
  await Bun.write(
    join(tempDir, "src/main.tsx"),
    `import { ClerkProvider } from "@clerk/react";
import App from "./App";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <ClerkProvider><App /></ClerkProvider>
);
`,
  );

  const plan = await reactVite.scaffold(makeCtx());

  expect(findAction(plan.actions, "src/main.tsx")).toMatchObject({
    type: "skip",
    skipReason: "Already has ClerkProvider",
  });
});

test("returns empty actions with post-instruction when no entry file found", async () => {
  const plan = await reactVite.scaffold(makeCtx());

  expect(plan.actions).toHaveLength(0);
  expect(plan.postInstructions.some((i) => i.includes("ClerkProvider"))).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("@clerk/react"))).toBe(true);
});

test("uses .jsx extension when typescript is false", async () => {
  await mkdir(join(tempDir, "src"), { recursive: true });
  await Bun.write(
    join(tempDir, "src/main.jsx"),
    `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
  );

  const plan = await reactVite.scaffold(makeCtx({ typescript: false }));

  const entry = findAction(plan.actions, "src/main.jsx");
  expect(entry.type).toBe("modify");
});

test("finds root main.tsx when srcDir is false", async () => {
  await Bun.write(
    join(tempDir, "main.tsx"),
    `import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
`,
  );

  const plan = await reactVite.scaffold(makeCtx({ srcDir: false }));

  const entry = findAction(plan.actions, "main.tsx");
  expect(entry.type).toBe("modify");
});

test("includes env var post-instruction", async () => {
  await mkdir(join(tempDir, "src"), { recursive: true });
  await Bun.write(
    join(tempDir, "src/main.tsx"),
    `import ReactDOM from "react-dom/client";
import App from "./App";
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
`,
  );

  const plan = await reactVite.scaffold(makeCtx());

  expect(plan.postInstructions.some((i) => i.includes("VITE_CLERK_PUBLISHABLE_KEY"))).toBe(true);
});
