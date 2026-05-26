import { describe, expect, test } from "bun:test";
import {
  buildOAuthProviderDescriptors,
  providerFields,
  providerLabel,
  type OAuthProviderDescriptor,
} from "./providers.ts";
import type { InstanceConfigSchema } from "../../lib/plapi.ts";

const oauthSchema = (properties: Record<string, unknown>) => ({
  type: "object",
  description: "OAuth SSO connection configuration",
  properties: {
    enabled: { type: "boolean", default: false },
    authenticatable: { type: "boolean", default: true },
    block_email_subaddresses: { type: "boolean", default: false },
    ...properties,
  },
});

const basicOAuthSchema = oauthSchema({
  client_id: { type: "string", description: "OAuth client ID" },
  client_secret: {
    type: "string",
    description: "OAuth client secret",
    "x-clerk-sensitive": true,
  },
});

const schemaResponse = (properties: Record<string, unknown>): InstanceConfigSchema => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://clerk.com/schemas/platform-config/2025-01-01",
  type: "object",
  properties: properties as InstanceConfigSchema["properties"],
});

function descriptorByProvider(
  descriptors: readonly OAuthProviderDescriptor[],
  provider: string,
): OAuthProviderDescriptor {
  const descriptor = descriptors.find((item) => item.provider === provider);
  if (!descriptor) throw new Error(`missing descriptor for ${provider}`);
  return descriptor;
}

describe("deploy OAuth provider descriptors", () => {
  test("builds a descriptor for public providers from schema and shared metadata", () => {
    const result = buildOAuthProviderDescriptors(
      ["discord"],
      schemaResponse({ connection_oauth_discord: basicOAuthSchema }),
    );

    expect(result.unsupported).toEqual([]);
    const discord = descriptorByProvider(result.supported, "discord");
    expect(discord.label).toBe("Discord");
    expect(discord.configKey).toBe("connection_oauth_discord");
    expect(discord.docsUrl).toContain("/discord");
    expect(discord.fields.map((field) => field.key)).toEqual(["client_id", "client_secret"]);
    expect(discord.fields.map((field) => field.label)).toEqual(["Client ID", "Client Secret"]);
    expect(discord.fields[1]).toMatchObject({ secret: true });
    expect(discord.requiredCredentialKeys).toEqual(["client_id", "client_secret"]);
  });

  test("supports schema-compatible providers without a static deploy allowlist", () => {
    const result = buildOAuthProviderDescriptors(
      ["google", "example_schema_provider"],
      schemaResponse({
        connection_oauth_google: basicOAuthSchema,
        connection_oauth_example_schema_provider: basicOAuthSchema,
      }),
    );

    expect(result.supported.map((item) => item.provider)).toEqual([
      "google",
      "example_schema_provider",
    ]);
    expect(result.unsupported).toEqual([]);
  });

  test("Google descriptor exposes manual and JSON credential sources", () => {
    const result = buildOAuthProviderDescriptors(
      ["google"],
      schemaResponse({
        connection_oauth_google: oauthSchema({
          client_id: { type: "string", description: "Google OAuth client ID" },
          client_secret: {
            type: "string",
            description: "Google OAuth client secret",
            "x-clerk-sensitive": true,
          },
          show_account_selector_prompt: {
            type: "boolean",
            description: "Whether to show the account selector prompt during OAuth flow",
            default: false,
          },
        }),
      }),
    );

    const google = descriptorByProvider(result.supported, "google");
    expect(google.credentialSources).toEqual(["manual", "google-json"]);
    expect(google.fields.map((field) => field.key)).toEqual(["client_id", "client_secret"]);
    expect(result.unsupported).toEqual([]);
  });

  test("marks missing schema as unsupported", () => {
    const result = buildOAuthProviderDescriptors(["discord"], schemaResponse({}));

    expect(result.supported).toEqual([]);
    expect(result.unsupported).toEqual(["discord"]);
  });

  test("uses enum fields for provider-specific select prompts", () => {
    const result = buildOAuthProviderDescriptors(
      ["linear"],
      schemaResponse({
        connection_oauth_linear: oauthSchema({
          client_id: { type: "string", description: "Linear OAuth client ID" },
          client_secret: {
            type: "string",
            description: "Linear OAuth client secret",
            "x-clerk-sensitive": true,
          },
          actor: {
            type: "string",
            description: "Actor type for Linear OAuth token",
            enum: ["user", "application"],
            default: "user",
          },
        }),
      }),
    );

    const linear = descriptorByProvider(result.supported, "linear");
    expect(linear.fields).toContainEqual({
      key: "actor",
      label: "Actor",
      description: "Actor type for Linear OAuth token",
      type: "select",
      options: ["user", "application"],
      defaultValue: "user",
      secret: false,
      filePath: false,
    });
  });

  test("applies Apple production credential overrides", () => {
    const result = buildOAuthProviderDescriptors(
      ["apple"],
      schemaResponse({
        connection_oauth_apple: oauthSchema({
          client_id: { type: "string", description: "Apple Services ID" },
          client_secret: {
            type: "string",
            description: "Apple Private Key",
            "x-clerk-sensitive": true,
          },
          key_id: { type: "string", description: "Apple Key ID" },
          team_id: { type: "string", description: "Apple Team ID" },
          bundle_id: {
            type: "string",
            description: "iOS app Bundle ID for native Sign in with Apple",
          },
        }),
      }),
    );

    const apple = descriptorByProvider(result.supported, "apple");
    expect(apple.fields.map((field) => field.key)).toEqual([
      "client_id",
      "team_id",
      "key_id",
      "client_secret",
    ]);
    expect(apple.fields.map((field) => field.label)).toEqual([
      "Apple Services ID",
      "Apple Team ID",
      "Apple Key ID",
      "Apple Private Key - path to .p8 file",
    ]);
    expect(apple.fields.find((field) => field.key === "client_secret")).toMatchObject({
      filePath: true,
      label: "Apple Private Key - path to .p8 file",
    });
    expect(apple.requiredCredentialKeys).toEqual([
      "client_id",
      "team_id",
      "key_id",
      "client_secret",
    ]);
  });

  test("keeps compatibility prompt labels only for behavioral overrides", () => {
    expect(providerFields("google").map((field) => field.label)).toEqual([
      "Client ID",
      "Client Secret",
    ]);
    expect(providerFields("microsoft").map((field) => field.label)).toEqual([
      "Client ID",
      "Client Secret",
    ]);
    expect(providerFields("apple").map((field) => field.label)).toEqual([
      "Apple Services ID",
      "Apple Team ID",
      "Apple Key ID",
      "Apple Private Key - path to .p8 file",
    ]);
    expect(providerFields("linear").map((field) => field.label)).toEqual([
      "Client ID",
      "Client Secret",
    ]);
  });

  test("providerLabel falls back to title-cased unknown slugs", () => {
    expect(providerLabel("linkedin_oidc")).toBe("LinkedIn");
    expect(providerLabel("new_provider")).toBe("New Provider");
  });
});
