import { buildDashboardUrl } from "../../../lib/environment.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { decodePublishableKey } from "../../../lib/fapi.ts";
import { hasCapabilities, readEntitlements } from "./capabilities.ts";
import { discoverRemote } from "./identity.ts";
import { configuredPublishableKey, scanSwiftSources, type SwiftScan } from "./publishable-key.ts";
import { remoteActions, type NativeAPI } from "./remote.ts";
import type { Check } from "./sdk-health.ts";
import type { Inspection } from "./xcode.ts";

/** Entitlements as Xcode signs them: `$(SETTING)` and `${SETTING}` take the configuration's values. */
function expandSettings(source: string, settings: Record<string, string>): string {
  return source.replace(
    /\$(?:\(([A-Za-z_]\w*)\)|\{([A-Za-z_]\w*)\})/g,
    (match, paren: string | undefined, brace: string | undefined) => {
      const value = settings[(paren ?? brace)!];
      return value === undefined
        ? match
        : value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
  );
}

/**
 * Read-only checks that the app's non-Debug configurations are ready for the
 * production instance: its native registration, the Associated Domain in the
 * entitlements they sign with, and the publishable key they configure Clerk
 * with. Setup only ever configures development, so none of this is something
 * `clerk init` completes; each warning carries its own remedy.
 */
export async function auditProduction(
  inspection: Inspection,
  remote: { applicationId: string; appIdPrefix?: string },
  api: NativeAPI,
  signal?: AbortSignal,
): Promise<Check[]> {
  const { applicationId } = remote;
  const application = await api.fetchApplication(applicationId, { includeSecretKeys: false });
  const production = application.instances.find(
    (instance) => instance.environment_type === "production",
  );
  if (!production)
    return [
      {
        name: "Production instance",
        status: "pass",
        message:
          "No production instance yet. Release checks for its registration, Associated Domain, and publishable key start after `clerk deploy`.",
      },
    ];
  const contexts = inspection.contexts.filter(
    (context) => context.selection.configuration !== "Debug",
  );
  if (!contexts.length)
    return [
      {
        name: "Production instance",
        status: "pass",
        message:
          "Production checks cover non-Debug configurations. Rerun without --xcode-configuration, or with --xcode-configuration Release.",
      },
    ];
  let host: string;
  try {
    host = decodePublishableKey(production.publishable_key).fapiHost;
  } catch (error) {
    return [
      {
        name: "Production instance",
        status: "warn",
        message: `The production instance's publishable key could not be read: ${errorMessage(error)}`,
      },
    ];
  }
  const dashboard = (path: string) =>
    buildDashboardUrl(applicationId, production.instance_id, path);
  const configurations = contexts.map((context) => context.selection.configuration).join(", ");
  const checks: Check[] = [];

  const registration = "Production native registration";
  const registrationRemedy = `Register the app and enable Native API for production at ${dashboard("native-applications")}`;
  try {
    const discovery = await discoverRemote(
      { applicationId, instanceId: production.instance_id, appIdPrefix: remote.appIdPrefix },
      { ...inspection, contexts },
      api,
      undefined,
      "production",
    );
    if (!discovery.context)
      checks.push({
        name: registration,
        status: "warn",
        message: `${configurations}: ${discovery.issues.join(" ")}`,
        remedy: registrationRemedy,
      });
    else {
      const { bundleIdentifier, appIdPrefix } = discovery.context;
      const actions = remoteActions(
        discovery.context,
        discovery.nativeEnabled,
        discovery.registrations,
      );
      checks.push(
        actions.length
          ? {
              name: registration,
              status: "warn",
              message: [
                actions.includes("register-application") &&
                  `${bundleIdentifier} (App ID Prefix ${appIdPrefix}) isn't registered on the production instance.`,
                actions.includes("enable-native-api") &&
                  "Native API is disabled on the production instance.",
              ]
                .filter(Boolean)
                .join(" "),
              remedy: registrationRemedy,
            }
          : {
              name: registration,
              status: "pass",
              message: `${bundleIdentifier} is registered on the production instance with App ID Prefix ${appIdPrefix}, and Native API is enabled.`,
            },
      );
    }
  } catch (error) {
    signal?.throwIfAborted();
    checks.push({
      name: registration,
      status: "warn",
      message: `The production native registration could not be checked: ${errorMessage(error)}`,
      remedy: registrationRemedy,
    });
  }

  const domain = `webcredentials:${host}`;
  for (const context of contexts) {
    const configuration = context.selection.configuration;
    let check: Pick<Check, "status" | "message">;
    try {
      const source = await readEntitlements(context);
      check =
        source === undefined
          ? {
              status: "warn",
              message: `${configuration} signs without an entitlements file, so it lacks ${domain}.`,
            }
          : hasCapabilities(expandSettings(source, context.settings), domain)
            ? { status: "pass", message: `${configuration} entitlements include ${domain}.` }
            : {
                status: "warn",
                message: `${configuration} entitlements don't include ${domain}, so passkeys and credential AutoFill won't work against production.`,
              };
    } catch {
      check = {
        status: "warn",
        message: `${configuration} entitlements could not be read; check its Associated Domains in Xcode.`,
      };
    }
    checks.push({
      name: `Production associated domain: ${configuration}`,
      ...check,
      remedy: `In Xcode's Signing & Capabilities, add ${domain} to Associated Domains for ${configuration}. An entitlements file shared with Debug can list both the development and production domains.`,
    });
  }

  let scan: SwiftScan | undefined;
  for (const context of contexts) {
    const configuration = context.selection.configuration;
    scan ??= await scanSwiftSources(inspection);
    const configured = await configuredPublishableKey(context, scan);
    const name = `Production publishable key: ${configuration}`;
    const remedy = `Build ${configuration} with the production publishable key from ${dashboard("api-keys")}.`;
    if (configured.status === "unresolved") {
      checks.push({
        name,
        status: "warn",
        message: `Not verified: ${configured.reason}. Confirm ${configuration} builds pass the production instance's publishable key to Clerk.configure.`,
        remedy,
      });
      continue;
    }
    // Keys are compared, never printed.
    let message: string;
    try {
      const decoded = decodePublishableKey(configured.key);
      message =
        configured.key === production.publishable_key
          ? ""
          : decoded.instanceType === "development"
            ? `${configuration} uses a development publishable key (from ${configured.source}), so its builds sign in against the development instance.`
            : `${configuration} uses the production publishable key of a different instance (${decoded.fapiHost}, from ${configured.source}).`;
    } catch {
      message = `${configuration} configures Clerk with a malformed publishable key (from ${configured.source}).`;
    }
    checks.push(
      message
        ? { name, status: "warn", message, remedy }
        : {
            name,
            status: "pass",
            message: `${configuration} uses the production instance's publishable key (from ${configured.source}).`,
          },
    );
  }
  return checks;
}
