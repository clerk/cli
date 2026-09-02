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
  mockState,
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
  expect(result.exitCode).toBe(2);
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

test("init creates and links a real app when authed in agent mode", async () => {
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

test("init creates and links a real app on a formerly gated framework when authed in agent mode", async () => {
  await writeReactProject();
  const devInstance = getInstance(MOCK_APP, "development");
  http.mock({
    "/v1/platform/applications": MOCK_APP,
  });

  await clerk("--mode", "agent", "init", "--no-skills");

  const env = parseEnvFile(await Bun.file(join(h.tempDir, ".env.local")).text(), ".env.local");
  expect(env.get("VITE_CLERK_PUBLISHABLE_KEY")).toBe(devInstance.publishable_key);
  expect(env.get("CLERK_SECRET_KEY")).toBe(devInstance.secret_key);

  const config = await readConfig();
  expect(config.profiles["github.com/test/project"]?.appId).toBe(MOCK_APP.application_id);
});

test("init mints an accountless app on a formerly gated framework when unauthenticated in agent mode", async () => {
  await writeReactProject();
  delete process.env.CLERK_PLATFORM_API_KEY;
  mockState.storedToken = null;
  http.mock({
    "/v1/accountless_applications": {
      publishable_key: "pk_test_accountless",
      secret_key: "sk_test_accountless",
      claim_url: "https://dashboard.clerk.com/apps/claim?token=tok_react&framework=react",
    },
  });

  await clerk("--mode", "agent", "init", "--no-skills");

  const env = parseEnvFile(await Bun.file(join(h.tempDir, ".env.local")).text(), ".env.local");
  expect(env.get("VITE_CLERK_PUBLISHABLE_KEY")).toBe("pk_test_accountless");
  expect(env.get("CLERK_SECRET_KEY")).toBe("sk_test_accountless");

  const breadcrumb = await Bun.file(join(h.tempDir, ".clerk", "keyless.json")).json();
  expect(breadcrumb.claimToken).toBe("tok_react");
  expect(await Bun.file(join(h.tempDir, ".gitignore")).text()).toContain(".clerk/");
  expect(http.requests.find((r) => r.url.includes("/v1/accountless_applications"))?.method).toBe(
    "POST",
  );
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
