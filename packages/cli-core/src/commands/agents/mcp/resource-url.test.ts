import { test, expect, describe } from "bun:test";
import { protectedResourceMetadataUrl, resourceIdentity, sameResource } from "./resource-url.ts";

describe("resourceIdentity", () => {
  test.each([
    ["https://mcp.example.com/mcp", "https://mcp.example.com/mcp"],
    ["HTTPS://MCP.Example.COM/mcp", "https://mcp.example.com/mcp"],
    ["https://mcp.example.com:443/mcp", "https://mcp.example.com/mcp"],
    ["https://mcp.example.com:/mcp", "https://mcp.example.com/mcp"],
    ["https://mcp.example.com:0443/mcp", "https://mcp.example.com:0443/mcp"],
    ["https://mcp.example.com:8443/mcp", "https://mcp.example.com:8443/mcp"],
    ["https://mcp.example.com/MCP/", "https://mcp.example.com/MCP/"],
    ["https://mcp.example.com/mcp?b=2&a=1", "https://mcp.example.com/mcp?b=2&a=1"],
    ["https://mcp.example.com", "https://mcp.example.com"],
  ])("%s -> %s", (value, expected) => {
    expect(resourceIdentity(value)).toBe(expected);
  });

  test.each([
    "http://mcp.example.com/mcp",
    "https://mcp.example.com/mcp#tools",
    "https://user:pass@mcp.example.com/mcp",
    "mcp.example.com/mcp",
  ])("%s is not a resource the registry stores", (value) => {
    expect(resourceIdentity(value)).toBeUndefined();
  });
});

describe("sameResource", () => {
  test.each([
    ["https://mcp.example.com/mcp", "https://MCP.example.com:443/mcp", true],
    ["https://mcp.example.com/mcp", "https://mcp.example.com/mcp/", false],
    ["https://mcp.example.com/mcp", "https://mcp.example.com/Mcp", false],
    ["https://mcp.example.com/mcp", "https://mcp.example.com:0443/mcp", false],
    ["https://mcp.example.com/mcp?a=1", "https://mcp.example.com/mcp", false],
    ["http://mcp.example.com/mcp", "http://mcp.example.com/mcp", false],
  ])("%s and %s: %p", (a, b, expected) => {
    expect(sameResource(a, b)).toBe(expected);
  });
});

describe("protectedResourceMetadataUrl", () => {
  test.each([
    ["https://mcp.example.com", "https://mcp.example.com/.well-known/oauth-protected-resource"],
    ["https://mcp.example.com/", "https://mcp.example.com/.well-known/oauth-protected-resource"],
    [
      "https://mcp.example.com/mcp",
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    ],
    [
      "https://mcp.example.com:8443/v1/mcp/",
      "https://mcp.example.com:8443/.well-known/oauth-protected-resource/v1/mcp/",
    ],
    [
      "https://mcp.example.com/mcp?tenant=a",
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp?tenant=a",
    ],
    [
      "https://mcp.example.com/?tenant=a",
      "https://mcp.example.com/.well-known/oauth-protected-resource?tenant=a",
    ],
  ])("%s -> %s", (resource, expected) => {
    expect(protectedResourceMetadataUrl(resource)).toBe(expected);
  });
});
