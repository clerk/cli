/**
 * What every `clerk agents mcp` subcommand shares: the entry flow
 * (`runMcpCommand`: check the URL, resolve the instance, read its OAuth state,
 * run, print), and the rules for which resources are MCP servers and which
 * settings still block MCP clients.
 *
 * Mirrors clerk/cloudflare-workers workers/remote-mcp-server/src/tools/mcp-server.ts:
 * `resolveMcpInstance` is its `resolveTrustedInstance`, `readOAuthState` its
 * `readSettings` plus `listResources`, and `isLegacyMcpServer` and `mcpBlockers`
 * its `isLegacyMcpServer` and `blockers`. Change them in step.
 */

import { fetchApplicationInstance, resolveAppContext } from "../../../lib/config.ts";
import {
  CliError,
  ERROR_CODE,
  PlapiError,
  throwUsageError,
  withApiContext,
} from "../../../lib/errors.ts";
import { log } from "../../../lib/log.ts";
import {
  fetchOAuthApplicationSettings,
  listOAuthResources,
  type OAuthApplicationSettings,
  type OAuthResource,
} from "../../../lib/plapi.ts";
import {
  issuerFromPublishableKey,
  mcpResourceName,
  protectedResourceMetadataUrl,
  resourceUrlProblem,
} from "./resource-url.ts";
import { withSpinner } from "../../../lib/spinner.ts";
import { isAgent } from "../../../mode.ts";

/**
 * The `--app` / `--instance` / `--json` options every `clerk agents mcp`
 * subcommand takes.
 */
export interface McpTargetOptions {
  app?: string;
  instance?: string;
  json?: boolean;
}

/**
 * The instance a command targets, as PLAPI describes it.
 */
export interface McpInstance {
  applicationId: string;
  instanceId: string;
  /**
   * The instance's Frontend API origin, the issuer of its tokens.
   */
  issuer: string | undefined;
  /**
   * How to name the instance to a person: `My App (development)`.
   */
  label: string;
}

/**
 * A blocker: a saved OAuth setting that stops MCP clients from working.
 */
export interface McpBlocker {
  setting: "aud_claim_enabled" | "client_id_metadata_documents_advertised";
  reason: string;
}

const BLOCKERS = {
  aud_claim_enabled:
    "Access tokens carry no audience claim, so the MCP server cannot require its own URL as the audience.",
  client_id_metadata_documents_advertised:
    "MCP clients cannot register: neither client ID metadata documents nor dynamic client registration is enabled.",
} as const;

/**
 * Resolves `--app` and `--instance` (or the linked profile) to an instance.
 * The application is always fetched, so only PLAPI decides which instance a
 * selector names, and the instance's publishable key gives its issuer.
 */
export async function resolveMcpInstance(options: McpTargetOptions): Promise<McpInstance> {
  const linked = options.app ? undefined : await resolveAppContext(options);
  const applicationId = options.app ?? linked!.appId;
  const { app, instance, instanceId, instanceLabel } = await withApiContext(
    fetchApplicationInstance(applicationId, linked?.instanceId ?? options.instance, {
      includeSecretKeys: false,
    }),
    "Failed to fetch application",
  );
  return {
    applicationId,
    instanceId,
    issuer: issuerFromPublishableKey(instance.publishable_key),
    label: `${app.name || applicationId} (${instanceLabel})`,
  };
}

/**
 * Runs an OAuth settings or resources call, turning PLAPI's refusal for an
 * application on the legacy OAuth provider into an actionable error.
 */
export async function withProviderGuard<T>(run: Promise<T>, context: string): Promise<T> {
  try {
    return await withApiContext(run, context);
  } catch (error) {
    if (
      error instanceof PlapiError &&
      error.status === 403 &&
      error.code === "feature_not_enabled"
    ) {
      throw new CliError(
        "This application still uses the legacy OAuth provider, which cannot host MCP servers. Migrate it to the new OAuth provider on the OAuth applications page of the Clerk Dashboard, then try again.",
        { code: ERROR_CODE.LEGACY_OAUTH_PROVIDER },
      );
    }
    throw error;
  }
}

/**
 * The instance's OAuth application settings and every OAuth resource
 * registered on it, as one read.
 */
export interface McpOAuthState {
  settings: OAuthApplicationSettings;
  resources: OAuthResource[];
}

async function readOAuthState(target: McpInstance): Promise<McpOAuthState> {
  const [settings, resources] = await Promise.all([
    withProviderGuard(
      fetchOAuthApplicationSettings(target.applicationId, target.instanceId),
      "Failed to fetch OAuth settings",
    ),
    withProviderGuard(
      listOAuthResources(target.applicationId, target.instanceId),
      "Failed to list OAuth resources",
    ),
  ]);
  return { settings, resources };
}

/**
 * How a `clerk agents mcp` subcommand runs on its target.
 */
export interface McpCommand<T> {
  /** The spinner text while the command runs. */
  spinnerText: (target: McpInstance) => string;
  run: (target: McpInstance, state: McpOAuthState) => Promise<T>;
  printHuman: (result: T, target: McpInstance) => void;
}

/**
 * The flow every `clerk agents mcp` subcommand shares: check the URL (when one
 * is given), resolve the instance, read its OAuth state and run the command
 * under a spinner, then print the result as JSON (`--json` or agent mode) or
 * for a person. Returns the result for the caller to act on.
 */
export async function runMcpCommand<T>(
  url: string | undefined,
  options: McpTargetOptions,
  command: McpCommand<T>,
): Promise<T> {
  const problem = url === undefined ? undefined : resourceUrlProblem(url);
  if (problem) throwUsageError(`The MCP server URL ${problem}.`);

  const target = await resolveMcpInstance(options);
  const result = await withSpinner(command.spinnerText(target), async () =>
    command.run(target, await readOAuthState(target)),
  );

  if (options.json || isAgent()) log.data(JSON.stringify(result, null, 2));
  else command.printHuman(result, target);
  return result;
}

/**
 * Whether a resource looks like an MCP server the Dashboard registered before
 * resources carried the `mcp_server` marker: unowned, scopeless, and named the
 * way the Dashboard names one.
 */
export function isLegacyMcpServer(resource: OAuthResource): boolean {
  return (
    !resource.mcp_server &&
    !resource.oauth_application_id &&
    !resource.reserved_oauth_application_id &&
    resource.scopes.length === 0 &&
    resource.name === mcpResourceName(resource.uri)
  );
}

/**
 * The saved settings that stop MCP clients from working with the instance.
 */
export function mcpBlockers(settings: OAuthApplicationSettings): McpBlocker[] {
  const blockers: McpBlocker[] = [];
  if (!settings.aud_claim_enabled) {
    blockers.push({ setting: "aud_claim_enabled", reason: BLOCKERS.aud_claim_enabled });
  }
  if (
    !settings.client_id_metadata_documents_advertised &&
    !settings.dynamic_oauth_client_registration
  ) {
    blockers.push({
      setting: "client_id_metadata_documents_advertised",
      reason: BLOCKERS.client_id_metadata_documents_advertised,
    });
  }
  return blockers;
}

/**
 * The on/off switches among the instance's OAuth settings.
 */
export function oauthFlags(settings: OAuthApplicationSettings): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(settings).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
    ),
  );
}

/**
 * A resource as the commands report it.
 */
export interface McpServerSummary {
  id: string;
  uri: string;
  name: string;
}

export function serverSummary(resource: OAuthResource): McpServerSummary {
  return { id: resource.id, uri: resource.uri, name: resource.name };
}

/**
 * The authorization server an MCP server should point clients to.
 */
export interface AuthorizationServer {
  issuer: string | null;
  audience: string;
  protected_resource_metadata_url: string;
}

/**
 * The authorization server an MCP server at `resource` should point clients to.
 */
export function authorizationServer(target: McpInstance, resource: string): AuthorizationServer {
  return {
    issuer: target.issuer ?? null,
    audience: resource,
    protected_resource_metadata_url: protectedResourceMetadataUrl(resource),
  };
}

/**
 * Instructions an agent can follow to make the MCP server at `resource` accept
 * Clerk-issued tokens.
 */
export function setupPrompt(target: McpInstance, resource: string): string {
  const issuer = target.issuer ?? "<your Clerk Frontend API URL>";
  return [
    `Configure my MCP server at ${resource} to use Clerk as its OAuth authorization server.`,
    `Serve OAuth protected resource metadata (RFC 9728) at ${protectedResourceMetadataUrl(resource)} with "resource": ${JSON.stringify(resource)} and "authorization_servers": [${JSON.stringify(issuer)}].`,
    "Answer unauthenticated MCP requests with HTTP 401 and a WWW-Authenticate: Bearer header whose resource_metadata parameter points to that metadata URL.",
    `Accept only Clerk OAuth access tokens whose issuer is ${issuer} and whose audience is exactly ${resource}.`,
    `In an Express, Hono, or Next.js server, use @clerk/mcp-tools: wrap the MCP handler with clerkInstrumentHandler(handler, options), which verifies bearer tokens with Clerk, checks the audience, and sends the challenge, and pass the same options object, with resourceUrl ${JSON.stringify(resource)}, to protectedResourceMetadataHandler for the metadata response.`,
    `In a fetch Worker, such as on Cloudflare Workers, wrap the MCP handler with clerkInstrumentHandler from @clerk/mcp-tools/fetch with resourceUrl ${JSON.stringify(resource)} and route both ${resource} and ${protectedResourceMetadataUrl(resource)} to it: it serves the metadata as well as verifying tokens.`,
    `In any other server, verify bearer tokens using a configured createClerkClient from @clerk/backend: const result = await clerkClient.authenticateRequest(request, { acceptsToken: 'oauth_token', audience: ${JSON.stringify(resource)} }). Reject requests unless result.isAuthenticated is true before processing MCP requests.`,
  ].join(" ");
}
