import { log } from "../../../lib/log.ts";
import { green, red } from "../../../lib/color.ts";
import { CliError, ERROR_CODE, errorMessage, throwUsageError } from "../../../lib/errors.ts";
import { loggedFetch } from "../../../lib/fetch.ts";
import type { OAuthResource } from "../../../lib/plapi.ts";
import { protectedResourceMetadataUrl, sameResource } from "./resource-url.ts";
import {
  authorizationServer,
  isLegacyMcpServer,
  mcpBlockers,
  oauthFlags,
  runMcpCommand,
  serverSummary,
  setupPrompt,
  type AuthorizationServer,
  type McpBlocker,
  type McpInstance,
  type McpOAuthState,
  type McpServerSummary,
  type McpTargetOptions,
} from "./shared.ts";

const METADATA_TIMEOUT_MS = 10_000;

type CheckName =
  | "resource_registered"
  | "aud_claim_enabled"
  | "client_registration"
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
  mcp_server: McpServerSummary | null;
  authorization_server: AuthorizationServer | null;
  configuration: {
    status: "configured" | "not_configured" | "migration_required";
    mcp_servers: McpServerSummary[];
    legacy_mcp_servers: McpServerSummary[];
    oauth_settings: Record<string, boolean>;
    blockers: McpBlocker[];
  };
  checks: McpCheck[];
  passed: boolean;
  next_steps: string[];
  setup_prompt: string | null;
}

function pass(name: CheckName, message: string): McpCheck {
  return { name, status: "pass", message };
}

function fail(name: CheckName, message: string): McpCheck {
  return { name, status: "fail", message };
}

function uriList(resources: OAuthResource[]): string {
  return resources.map((r) => r.uri).join(", ");
}

/**
 * The URL to check: the one asked for, or else the instance's only MCP server
 * (or, with none, its only legacy registration). Several servers and no URL is
 * a usage error, and a requested URL that is neither a server nor a legacy
 * registration is refused, as the connector refuses both.
 */
function targetUrl(
  requested: string | undefined,
  servers: OAuthResource[],
  legacy: OAuthResource[],
): string | undefined {
  if (requested) {
    const known = [...servers, ...legacy].some((s) => sameResource(s.uri, requested));
    if (known) return requested;
    throw new CliError(
      `${requested} is not a registered MCP server URL on this instance. Registered: ${uriList(servers) || "none"}.`,
      { code: ERROR_CODE.MCP_SERVER_NOT_REGISTERED },
    );
  }
  if (servers.length > 1) {
    throwUsageError(
      `Pass the MCP server URL to check. Registered MCP server URLs: ${uriList(servers)}.`,
    );
  }
  return servers[0]?.uri ?? (legacy.length === 1 ? legacy[0]!.uri : undefined);
}

function registrationCheck(
  server: OAuthResource | undefined,
  legacy: OAuthResource | undefined,
  legacyServers: OAuthResource[],
): McpCheck {
  if (server) return pass("resource_registered", `${server.uri} is registered as an MCP server`);
  if (legacy) {
    return fail(
      "resource_registered",
      `${legacy.uri} is a legacy Dashboard registration not yet marked as an MCP server. Run \`clerk agents mcp configure ${legacy.uri}\` to mark it.`,
    );
  }
  // Several legacy registrations and no URL: name them, as the connector does.
  if (legacyServers.length) {
    return fail(
      "resource_registered",
      `No MCP server is marked on this instance. Legacy Dashboard registrations: ${uriList(legacyServers)}. Run \`clerk agents mcp configure <url>\` with one of them to mark it.`,
    );
  }
  return fail(
    "resource_registered",
    "No MCP server is registered on this instance. Run `clerk agents mcp configure <url>` to register one.",
  );
}

function settingChecks(blockers: McpBlocker[]): McpCheck[] {
  const blocked = (setting: McpBlocker["setting"]) => blockers.find((b) => b.setting === setting);
  const audience = blocked("aud_claim_enabled");
  const registration = blocked("client_id_metadata_documents_advertised");
  return [
    audience
      ? fail("aud_claim_enabled", audience.reason)
      : pass("aud_claim_enabled", "Access tokens carry an audience claim"),
    // The connector's blocker for this is keyed client_id_metadata_documents_advertised but
    // passes when either CIMD or DCR is on, so the check is named for what it tests.
    registration
      ? fail("client_registration", registration.reason)
      : pass(
          "client_registration",
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
  if (!uri) return fail(name, "No marked MCP server to read protected resource metadata for.");
  // Without the issuer the metadata can't be validated, so fail as the connector does.
  if (!issuer) return fail(name, "This instance's issuer could not be determined.");
  const url = protectedResourceMetadataUrl(uri);

  let response: Response;
  try {
    response = await loggedFetch(url, {
      tag: "mcp",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
  } catch (error) {
    return fail(name, `Could not reach ${url}: ${errorMessage(error)}`);
  }
  if (response.status !== 200) {
    return fail(name, `${url} answered HTTP ${response.status}, not 200.`);
  }

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
  if (!(Array.isArray(servers) && servers.includes(issuer))) {
    return fail(name, `${url} does not list ${issuer} in authorization_servers.`);
  }
  return pass(name, `${url} names ${uri} and lists ${issuer}`);
}

const SETTINGS_STEP =
  "Turn on the failing OAuth settings on the OAuth applications settings page of the Clerk Dashboard.";

const NEXT_STEPS: Record<CheckName, string> = {
  resource_registered: "Register the MCP server with `clerk agents mcp configure <url>`.",
  aud_claim_enabled: SETTINGS_STEP,
  client_registration: SETTINGS_STEP,
  protected_resource_metadata:
    "Implement the setup_prompt in your MCP server, deploy it, then run `clerk agents mcp check` again.",
};

function nextSteps(checks: McpCheck[], legacy: OAuthResource[]): string[] {
  const step = (name: CheckName) =>
    name === "resource_registered" && legacy.length
      ? `Mark a legacy Dashboard registration (${uriList(legacy)}) with \`clerk agents mcp configure <url>\`.`
      : NEXT_STEPS[name];
  const steps = checks.filter((c) => c.status === "fail").map((c) => step(c.name));
  return [...new Set(steps)];
}

function configurationStatus(
  servers: OAuthResource[],
  legacy: OAuthResource[],
): CheckResult["configuration"]["status"] {
  if (servers.length) return "configured";
  if (legacy.length) return "migration_required";
  return "not_configured";
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
  { settings, resources }: McpOAuthState,
): Promise<CheckResult> {
  const servers = resources.filter((r) => r.mcp_server);
  const legacyServers = resources.filter(isLegacyMcpServer);
  const blockers = mcpBlockers(settings);

  const wanted = targetUrl(requested, servers, legacyServers);
  const server = wanted ? servers.find((s) => sameResource(s.uri, wanted)) : undefined;
  const legacy =
    wanted && !server ? legacyServers.find((s) => sameResource(s.uri, wanted)) : undefined;
  // Report the URL as PLAPI stored it, since that is the audience tokens carry.
  const uri = server?.uri ?? legacy?.uri ?? wanted;

  const checks = [
    registrationCheck(server, legacy, legacyServers),
    ...settingChecks(blockers),
    await metadataCheck(uri, target.issuer),
  ];

  return {
    application_id: target.applicationId,
    instance_id: target.instanceId,
    resource_url: uri ?? null,
    mcp_server: server ? serverSummary(server) : null,
    authorization_server: uri ? authorizationServer(target, uri) : null,
    configuration: {
      status: configurationStatus(servers, legacyServers),
      mcp_servers: servers.map(serverSummary),
      legacy_mcp_servers: legacyServers.map(serverSummary),
      oauth_settings: oauthFlags(settings),
      blockers,
    },
    checks,
    passed: checks.every((c) => c.status === "pass"),
    next_steps: nextSteps(checks, legacyServers),
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
  const result = await runMcpCommand(url, options, {
    spinnerText: (target) => `Checking MCP server setup on ${target.label}...`,
    run: async (target, state) => checkMcpServer(target, url, state),
    printHuman,
  });

  if (!result.passed) {
    const failed = result.checks.filter((c) => c.status === "fail").map((c) => c.name);
    throw new CliError(`MCP server checks failed: ${failed.join(", ")}`, {
      code: ERROR_CODE.MCP_CHECK_FAILED,
    });
  }
}
