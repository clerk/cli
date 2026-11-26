import { test, expect, describe } from "bun:test";
import { type McpInstance, setupPrompt } from "./shared.ts";

const target = {
  applicationId: "app_1",
  instanceId: "ins_1",
  issuer: "https://example.clerk.accounts.dev",
  label: "My App (development)",
} as McpInstance;
const resource = "https://mcp.example.com/mcp";

describe("setupPrompt", () => {
  const prompt = setupPrompt(target, resource);

  test("teaches clerkInstrumentHandler, not the deprecated mcpAuth or withClerkMcpAuth", () => {
    expect(prompt).toContain("clerkInstrumentHandler");
    expect(prompt).not.toContain("mcpAuth");
    expect(prompt).not.toContain("withClerkMcpAuth");
  });

  test("pairs clerkInstrumentHandler with protectedResourceMetadataHandler in Express, Hono and Next.js", () => {
    expect(prompt).toContain("protectedResourceMetadataHandler");
    expect(prompt).toContain(`resourceUrl ${JSON.stringify(resource)}`);
  });

  test("routes the metadata URL to the fetch entry's clerkInstrumentHandler", () => {
    expect(prompt).toContain("@clerk/mcp-tools/fetch");
    expect(prompt).toContain("https://mcp.example.com/.well-known/oauth-protected-resource/mcp");
  });

  test("leaves activity reporting out", () => {
    expect(prompt).not.toContain("clerkInstrumentServer");
    expect(prompt).not.toContain("reporting");
  });
});
