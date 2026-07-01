/**
 * Agent mode provides actionable instructions
 * AI agents execute deterministic flows without interactive prompts.
 */

import { test, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  useIntegrationTestHarness,
  http,
  clerk,
  readConfig,
  MOCK_APP,
  getInstance,
  parseEnvFile,
} from "./lib/harness.ts";

const h = useIntegrationTestHarness();

async function writeNextAppProject() {
  await Bun.write(
    join(h.tempDir, "package.json"),
    JSON.stringify({
      name: "test-next-app",
      dependencies: {
        "@clerk/nextjs": "latest",
        next: "15.0.0",
        react: "19.0.0",
        "react-dom": "19.0.0",
      },
    }),
  );
  await Bun.write(join(h.tempDir, "tsconfig.json"), "{}");
  await mkdir(join(h.tempDir, "app"), { recursive: true });
  await Bun.write(
    join(h.tempDir, "app/layout.tsx"),
    `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
  );
}

async function writeReactProject() {
  await Bun.write(
    join(h.tempDir, "package.json"),
    JSON.stringify({
      name: "test-react-app",
      dependencies: {
        "@clerk/react": "latest",
        "@vitejs/plugin-react": "latest",
        vite: "6.0.0",
        react: "19.0.0",
        "react-dom": "19.0.0",
      },
    }),
  );
  await Bun.write(join(h.tempDir, "tsconfig.json"), "{}");
  await mkdir(join(h.tempDir, "src"), { recursive: true });
  await Bun.write(
    join(h.tempDir, "src/main.tsx"),
    `import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
`,
  );
}

test("link with --app writes the profile in agent mode", async () => {
  http.mock({
    [`/applications/${MOCK_APP.application_id}`]: MOCK_APP,
  });

  await clerk("--mode", "agent", "link", "--app", MOCK_APP.application_id);

  const config = await readConfig();
  expect(config.profiles["github.com/test/project"]?.appId).toBe(MOCK_APP.application_id);
  expect(
    http.requests.some((r) => r.url.includes(`/applications/${MOCK_APP.application_id}`)),
  ).toBe(true);
});

test("unlink requires --yes in agent mode", async () => {
  const result = await clerk.raw("--mode", "agent", "unlink");
  expect(result.exitCode).toBe(64);
  expect(result.stderr).toContain("Pass --yes to unlink in agent mode.");
});

test("unlink --yes removes the profile in agent mode", async () => {
  http.mock({
    [`/applications/${MOCK_APP.application_id}`]: MOCK_APP,
  });

  await clerk("--mode", "agent", "link", "--app", MOCK_APP.application_id);
  await clerk("--mode", "agent", "unlink", "--yes");

  const config = await readConfig();
  expect(config.profiles["github.com/test/project"]).toBeUndefined();
});

test("init creates and links a real app for keyless framework when authed in agent mode", async () => {
  await writeNextAppProject();
  const devInstance = getInstance(MOCK_APP, "development");
  http.mock({
    "/v1/platform/applications": MOCK_APP,
  });

  await clerk("--mode", "agent", "init", "--no-skills");

  const env = parseEnvFile(await Bun.file(join(h.tempDir, ".env.local")).text(), ".env.local");
  expect(env.get("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")).toBe(devInstance.publishable_key);
  expect(env.get("CLERK_SECRET_KEY")).toBe(devInstance.secret_key);

  const config = await readConfig();
  expect(config.profiles["github.com/test/project"]?.appId).toBe(MOCK_APP.application_id);
  // Accountless endpoint should not be hit when the user is already authed.
  expect(http.requests.some((r) => r.url.includes("/v1/accountless_applications"))).toBe(false);
});

test("init prints manual setup for non-keyless framework without an app target in agent mode", async () => {
  await writeReactProject();

  const { stderr } = await clerk("--mode", "agent", "init", "--no-skills");

  expect(stderr).toContain("clerk init --app <app_id>");
  expect(http.requests).toHaveLength(0);
});

test("init with --app uses real app flow in agent mode", async () => {
  await writeReactProject();
  const devInstance = getInstance(MOCK_APP, "development");
  http.mock({
    [`/applications/${MOCK_APP.application_id}`]: MOCK_APP,
  });

  await clerk("--mode", "agent", "init", "--app", MOCK_APP.application_id, "--no-skills");

  const config = await readConfig();
  expect(config.profiles["github.com/test/project"]?.appId).toBe(MOCK_APP.application_id);

  const env = parseEnvFile(await Bun.file(join(h.tempDir, ".env.local")).text(), ".env.local");
  expect(env.get("VITE_CLERK_PUBLISHABLE_KEY")).toBe(devInstance.publishable_key);
  expect(env.get("CLERK_SECRET_KEY")).toBe(devInstance.secret_key);
});
