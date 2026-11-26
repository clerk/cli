import { log } from "../../../lib/log.ts";
import { green, red } from "../../../lib/color.ts";
import { CliError, ERROR_CODE, errorMessage, throwUsageError } from "../../../lib/errors.ts";
import { loggedFetch } from "../../../lib/fetch.ts";
import type { OAuthResource } from "../../../lib/plapi.ts";
import { withSpinner } from "../../../lib/spinner.ts";
import { isAgent } from "../../../mode.ts";
import { protectedResourceMetadataUrl, resourceUrlProblem, sameResource } from "./resource-url.ts";
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
  type McpBlocker,
  type McpInstance,
  type McpTargetOptions,
} from "./shared.ts";

const METADATA_TIMEOUT_MS = 10_000;

type CheckName =
  | "resource_registered"
  | "aud_claim_enabled"
  | "client_id_metadata_documents_advertised"
  | "protected_resource_metadata";

/**
 * One configuration check and its outcome.
 */
export interface McpCheck {
  name: CheckName;
  status: "pass" | "fail";
  message: string;
}

/**
 * What `clerk agents mcp check` found, as it reports it.
 */
export interface CheckResult {
  application_id: string;
  instance_id: string;
  resource_url: string | null;
  mcp_server: ReturnType<typeof serverSummary> | null;
  authorization_server: ReturnType<typeof authorizationServer> | null;
  configuration: {
    status: "configured" | "not_configured" | "migration_required";
    mcp_servers: ReturnType<typeof serverSummary>[];
    legacy_mcp_servers: ReturnType<typeof serverSummary>[];
    oauth_settings: Record<string, boolean>;
    blockers: McpBlocker[];
  };
  checks: McpCheck[];
  passed: boolean;
  next_steps: string[];
  setup_prompt: string | null;
}

const pass = (name: CheckName, message: string): McpCheck => ({ name, status: "pass", message });
const fail = (name: CheckName, message: string): McpCheck => ({ name, status: "fail", message });

/**
 * The URL to check: the one asked for, or else the instance's only MCP server
 * (or, with none, its only legacy registration). Several servers and no URL is
 * a usage error, as the connector refuses it.
 */
function targetUrl(
  requested: string | undefined,
  servers: OAuthResource[],
  legacy: OAuthResource[],
): string | undefined {
  if (requested) return requested;
  if (servers.length > 1) {
    throwUsageError(
      `Pass the MCP server URL to check. Registered MCP server URLs: ${servers.map((s) => s.uri).join(", ")}.`,
    );
  }
  return servers[0]?.uri ?? (legacy.length === 1 ? legacy[0]!.uri : undefined);
}

function registrationCheck(
  uri: string | undefined,
  server: OAuthResource | undefined,
  legacy: OAuthResource | undefined,
): McpCheck {
  if (server) return pass("resource_registered", `${server.uri} is registered as an MCP server`);
  if (legacy) {
    return fail(
      "resource_registered",
      `${legacy.uri} is a legacy Dashboard registration not yet marked as an MCP server. Run \`clerk agents mcp configure ${legacy.uri}\` to mark it.`,
    );
  }
  if (!uri) {
    return fail(
      "resource_registered",
      "No MCP server is registered on this instance. Run `clerk agents mcp configure <url>` to register one.",
    );
  }
  return fail(
    "resource_registered",
    `${uri} is not a registered MCP server URL on this instance. Run \`clerk agents mcp configure ${uri}\` to register it.`,
  );
}

function settingChecks(found: McpBlocker[]): McpCheck[] {
  const blocked = (setting: McpBlocker["setting"]) => found.find((b) => b.setting === setting);
  const audience = blocked("aud_claim_enabled");
  const registration = blocked("client_id_metadata_documents_advertised");
  return [
    audience
      ? fail("aud_claim_enabled", audience.reason)
      : pass("aud_claim_enabled", "Access tokens carry an audience claim"),
    registration
      ? fail("client_id_metadata_documents_advertised", registration.reason)
      : pass(
          "client_id_metadata_documents_advertised",
          "MCP clients can register with client ID metadata documents or dynamic client registration",
        ),
  ];
}

/**
 * Reads the server's protected resource metadata with one unauthenticated GET.
 * RFC 9728 §3 puts it at the well-known URL derived from the resource, and §3.3
 * says metadata whose `resource` is not identical to that resource must not be
 * used. No MCP request is sent.
 */
async function metadataCheck(
  uri: string | undefined,
  issuer: string | undefined,
): Promise<McpCheck> {
  const name = "protected_resource_metadata";
  if (!uri) return fail(name, "No MCP server URL to read protected resource metadata for.");
  const url = protectedResourceMetadataUrl(uri);

  let response: Response;
  try {
    response = await loggedFetch(url, {
      tag: "mcp-metadata",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
  } catch (error) {
    return fail(name, `Could not reach ${url}: ${errorMessage(error)}`);
  }
  if (response.status !== 200)
    return fail(name, `${url} answered HTTP ${response.status}, not 200.`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return fail(name, `${url} did not return JSON.`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail(name, `${url} did not return a JSON object.`);
  }
  const { resource, authorization_servers: servers } = body as Record<string, unknown>;
  if (resource !== uri) {
    return fail(
      name,
      `${url} names resource ${JSON.stringify(resource)}, which is not identical to ${uri} (RFC 9728 §3.3).`,
    );
  }
  if (issuer && !(Array.isArray(servers) && servers.includes(issuer))) {
    return fail(name, `${url} does not list ${issuer} in authorization_servers.`);
  }
  return pass(name, `${url} names ${uri} and lists ${issuer ?? "its authorization servers"}`);
}

function nextSteps(checks: McpCheck[]): string[] {
  const failed = checks.filter((c) => c.status === "fail").map((c) => c.name);
  const steps: string[] = [];
  if (failed.includes("resource_registered")) {
    steps.push("Register the MCP server with `clerk agents mcp configure <url>`.");
  }
  if (
    failed.includes("aud_claim_enabled") ||
    failed.includes("client_id_metadata_documents_advertised")
  ) {
    steps.push(
      "Turn on the failing OAuth settings on the OAuth applications settings page of the Clerk Dashboard.",
    );
  }
  if (failed.includes("protected_resource_metadata")) {
    steps.push(
      "Implement the setup_prompt in your MCP server, deploy it, then run `clerk agents mcp check` again.",
    );
  }
  return steps;
}

/**
 * Checks the Clerk configuration of the MCP server at `requested` (or the
 * instance's only one).
 *
 * The configuration checks mirror `check_mcp_server` in clerk/cloudflare-workers
 * (workers/remote-mcp-server/src/tools/mcp-server.ts), duplicated on purpose so
 * the CLI needs no composite endpoint. A change to either must be made to both.
 * The connector reads a hosted discovery checker; this command has none, so it
 * reads the protected resource metadata itself and sends no MCP request.
 */
async function checkMcpServer(
  target: McpInstance,
  requested: string | undefined,
): Promise<CheckResult> {
  const settings = await readOAuthSettings(target);
  const resources = await readOAuthResources(target);
  const servers = resources.filter((r) => r.mcp_server);
  const legacyServers = resources.filter(isLegacyMcpServer);
  const found = mcpBlockers(settings);

  const wanted = targetUrl(requested, servers, legacyServers);
  const server = wanted ? servers.find((s) => sameResource(s.uri, wanted)) : undefined;
  const legacy =
    wanted && !server ? legacyServers.find((s) => sameResource(s.uri, wanted)) : undefined;
  // Report the URL as PLAPI stored it, since that is the audience tokens carry.
  const uri = server?.uri ?? legacy?.uri ?? wanted;

  const checks = [
    registrationCheck(uri, server, legacy),
    ...settingChecks(found),
    await metadataCheck(uri, target.issuer),
  ];

  return {
    application_id: target.applicationId,
    instance_id: target.instanceId,
    resource_url: uri ?? null,
    mcp_server: server ? serverSummary(server) : null,
    authorization_server: uri ? authorizationServer(target, uri) : null,
    configuration: {
      status: servers.length
        ? "configured"
        : legacyServers.length
          ? "migration_required"
          : "not_configured",
      mcp_servers: servers.map(serverSummary),
      legacy_mcp_servers: legacyServers.map(serverSummary),
      oauth_settings: oauthFlags(settings),
      blockers: found,
    },
    checks,
    passed: checks.every((c) => c.status === "pass"),
    next_steps: nextSteps(checks),
    setup_prompt: uri ? setupPrompt(target, uri) : null,
  };
}

function printHuman(result: CheckResult, target: McpInstance): void {
  log.info(`Checking ${result.resource_url ?? "MCP server"} on ${target.label}`);
  log.blank();
  for (const check of result.checks) {
    log.info(
      `  ${check.status === "pass" ? green("✓") : red("✗")} ${check.name}: ${check.message}`,
    );
  }
  for (const step of result.next_steps) {
    log.blank();
    log.warn(step);
  }
  if (!result.passed && result.setup_prompt) {
    log.blank();
    log.info("Setup prompt for your MCP server:");
    log.info(result.setup_prompt);
  }
}

/**
 * `clerk agents mcp check [url]`: reports whether a user's MCP server is
 * configured for Clerk, one pass or fail per check. Exits non-zero when any
 * check fails, like `clerk doctor`.
 */
export async function check(
  url: string | undefined,
  options: McpTargetOptions = {},
): Promise<void> {
  const problem = url ? resourceUrlProblem(url) : undefined;
  if (problem) throwUsageError(`The MCP server URL ${problem}.`);

  const target = await resolveMcpInstance(options);
  const result = await withSpinner(`Checking MCP server setup on ${target.label}...`, async () =>
    checkMcpServer(target, url),
  );

  if (options.json || isAgent()) {
    log.data(JSON.stringify(result, null, 2));
  } else {
    printHuman(result, target);
  }

  if (!result.passed) {
    const failed = result.checks.filter((c) => c.status === "fail").map((c) => c.name);
    throw new CliError(`MCP server checks failed: ${failed.join(", ")}`, {
      code: ERROR_CODE.MCP_CHECK_FAILED,
    });
  }
}
