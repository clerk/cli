/**
 * Allowlist of known stable subpaths under
 * `/apps/{appId}/instances/{instanceId}/...` in the Clerk dashboard.
 *
 * Sourced from the dashboard route tree at
 * apps/dashboard/app/(routes)/apps/[applicationId]/instances/[instanceId]/.
 *
 * Unknown subpaths are not blocked — the CLI just prints a warning so the
 * user knows they're navigating to a path the CLI hasn't verified.
 */
export const KNOWN_DASHBOARD_PATHS = [
  // Top-level pages
  "users",
  "organizations",
  "events",
  "logs",
  "billing",

  // Configure section
  "api-keys",
  "sessions",
  "settings",
  "instance-settings",
  "webhooks",
  "customization",
  "domains",
  "jwt-templates",
  "oauth-applications",
  "user-authentication",
  "organizations-settings",
  "machines",
  "native-applications",
  "integrations",
  "compliance",
  "audiences",
  "features",
  "account-portal",
  "paths",
  "plan-billing",
] as const;

export type KnownDashboardPath = (typeof KNOWN_DASHBOARD_PATHS)[number];

export function isKnownDashboardPath(path: string): path is KnownDashboardPath {
  // Match the first segment so deep paths like "users/user_xxx" still match.
  const head = path.split("/")[0] ?? "";
  return (KNOWN_DASHBOARD_PATHS as readonly string[]).includes(head);
}
