import { log } from "../../../lib/log.ts";
import { CliError, ERROR_CODE, throwUsageError } from "../../../lib/errors.ts";
import {
  createOAuthResource,
  patchOAuthApplicationSettings,
  updateOAuthResource,
  type OAuthApplicationSettings,
} from "../../../lib/plapi.ts";
import { withSpinner } from "../../../lib/spinner.ts";
import { isAgent } from "../../../mode.ts";
import { mcpResourceName, resourceUrlProblem, sameResource } from "./resource-url.ts";
import {
  authorizationServer,
  isLegacyMcpServer,
  mcpBlockers,
  oauthFlags,
  readOAuthResources,
  readOAuthSettings,
  resolveMcpInstance,
  serverSummary,
  setupPrompt,
  withProviderGuard,
  type McpBlocker,
  type McpInstance,
  type McpTargetOptions,
} from "./shared.ts";

type FirstServerSettings = Pick<
  OAuthApplicationSettings,
  "aud_claim_enabled" | "client_id_metadata_documents_advertised"
>;

/**
 * What `clerk agents mcp configure` did, as it reports it.
 */
export interface ConfigureResult {
  application_id: string;
  instance_id: string;
  resource_url: string;
  authorization_server: ReturnType<typeof authorizationServer>;
  mcp_server: ReturnType<typeof serverSummary>;
  configuration: {
    status: "unchanged" | "created" | "marked";
    enabled_settings: string[];
    oauth_settings: Record<string, boolean>;
    blockers: McpBlocker[];
  };
  setup_prompt: string;
  next_steps: string[];
}

// The first MCP server on an instance turns on the two settings MCP clients need, as the
// Dashboard does. PKCE and dynamic client registration are left alone: PKCE is instance-wide
// and may break existing clients, and CIMD is the registration the MCP spec prefers.
function firstServerPatch(settings: OAuthApplicationSettings): FirstServerSettings {
  return {
    ...(!settings.client_id_metadata_documents_advertised && {
      client_id_metadata_documents_advertised: true,
    }),
    ...(!settings.aud_claim_enabled && { aud_claim_enabled: true }),
  };
}

const SETUP_STEP =
  "Implement the setup_prompt in your MCP server and deploy it at the resource URL.";

function blockerSteps(blockers: McpBlocker[]): string[] {
  if (!blockers.length) return [];
  return [
    `Existing OAuth settings block MCP clients: ${blockers.map(({ setting }) => setting).join(", ")}. \`clerk agents mcp configure\` only turns settings on for the first MCP server; change these on the OAuth applications settings page of the Clerk Dashboard.`,
  ];
}

/**
 * Registers `url` as an MCP server on the instance.
 *
 * This sequence mirrors `configure_mcp_server` in clerk/cloudflare-workers
 * (workers/remote-mcp-server/src/tools/mcp-server.ts), duplicated on purpose so
 * the CLI needs no composite endpoint. A change to either must be made to both.
 * Its `replace_resource_url` and `dry_run` inputs and the hosted discovery
 * check have no counterpart here.
 */
async function configureMcpServer(
  target: McpInstance,
  requested: string,
): Promise<ConfigureResult> {
  const settings = await readOAuthSettings(target);
  const resources = await readOAuthResources(target);
  const servers = resources.filter((r) => r.mcp_server);

  const existing = servers.find((s) => sameResource(s.uri, requested));
  const conflicting = existing ? undefined : resources.find((r) => sameResource(r.uri, requested));
  const legacy = conflicting && isLegacyMcpServer(conflicting) ? conflicting : undefined;

  const report = (
    resource: ReturnType<typeof serverSummary>,
    status: ConfigureResult["configuration"]["status"],
    enabled: string[],
    saved: OAuthApplicationSettings,
  ): ConfigureResult => {
    const blockers = mcpBlockers(saved);
    return {
      application_id: target.applicationId,
      instance_id: target.instanceId,
      // Report the URL as PLAPI canonicalized it, since that is the audience tokens will carry.
      resource_url: resource.uri,
      authorization_server: authorizationServer(target, resource.uri),
      mcp_server: resource,
      configuration: {
        status,
        enabled_settings: enabled,
        oauth_settings: oauthFlags(saved),
        blockers,
      },
      setup_prompt: setupPrompt(target, resource.uri),
      next_steps: [SETUP_STEP, ...blockerSteps(blockers)],
    };
  };

  if (existing) return report(serverSummary(existing), "unchanged", [], settings);

  // Refuse unrelated resources before changing first-server settings.
  if (conflicting && !legacy) {
    throw new CliError(
      `${requested} is already registered on this instance as an OAuth resource (${conflicting.id}) that is not marked as an MCP server.`,
      { code: ERROR_CODE.OAUTH_RESOURCE_CONFLICT },
    );
  }

  const patch = servers.length === 0 ? firstServerPatch(settings) : {};
  const enabled = Object.keys(patch);
  const { applicationId, instanceId } = target;

  // Settings first: both switches are idempotent and wanted for the first server, so a
  // failed create or marker update is safe to retry. Otherwise a server could be left
  // without discovery or audience settings and no retry path.
  const saved = enabled.length
    ? await withProviderGuard(
        patchOAuthApplicationSettings(applicationId, instanceId, patch),
        "Failed to update OAuth settings",
      )
    : settings;
  const resource = legacy
    ? await withProviderGuard(
        updateOAuthResource(applicationId, instanceId, legacy.id, { mcp_server: true }),
        "Failed to mark the OAuth resource as an MCP server",
      )
    : await withProviderGuard(
        createOAuthResource(applicationId, instanceId, {
          uri: requested,
          name: mcpResourceName(requested),
          mcp_server: true,
        }),
        "Failed to register the OAuth resource",
      );

  return report(serverSummary(resource), legacy ? "marked" : "created", enabled, saved);
}

function headline(result: ConfigureResult, target: McpInstance): string {
  const url = result.resource_url;
  switch (result.configuration.status) {
    case "created":
      return `Registered ${url} as an MCP server on ${target.label}`;
    case "marked":
      return `Marked the existing registration of ${url} as an MCP server on ${target.label}`;
    case "unchanged":
      return `${url} is already registered as an MCP server on ${target.label}; nothing changed`;
  }
}

function printHuman(result: ConfigureResult, target: McpInstance): void {
  const { configuration, authorization_server: server } = result;
  log.success(headline(result, target));
  if (configuration.enabled_settings.length) {
    log.info(`Enabled OAuth settings: ${configuration.enabled_settings.join(", ")}`);
  }
  for (const blocker of configuration.blockers) log.warn(`${blocker.setting}: ${blocker.reason}`);
  log.blank();
  log.info(`Issuer: ${server.issuer ?? "unknown"}`);
  log.info(`Audience: ${server.audience}`);
  log.info(`Protected resource metadata: ${server.protected_resource_metadata_url}`);
  log.blank();
  log.info("Setup prompt for your MCP server:");
  log.info(result.setup_prompt);
  // The setup step is the prompt printed above; only the blocker steps follow it.
  for (const step of blockerSteps(configuration.blockers)) {
    log.blank();
    log.warn(step);
  }
}

/**
 * `clerk agents mcp configure <url>`: registers a user's MCP server with Clerk.
 */
export async function configure(url: string, options: McpTargetOptions = {}): Promise<void> {
  const problem = resourceUrlProblem(url);
  if (problem) throwUsageError(`The MCP server URL ${problem}.`);

  const target = await resolveMcpInstance(options);
  const result = await withSpinner(`Configuring ${url} on ${target.label}...`, async () =>
    configureMcpServer(target, url),
  );

  if (options.json || isAgent()) {
    log.data(JSON.stringify(result, null, 2));
    return;
  }
  printHuman(result, target);
}
