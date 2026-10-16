import { log } from "../../../lib/log.ts";
import { TEAM_ID } from "./starter-project.ts";
import type { Inspection } from "./xcode.ts";

export interface AppleTeam {
  id: string;
  name: string;
  /** A free Personal Team: simulator builds work, but Associated Domains and Sign in with Apple don't. */
  personal: boolean;
}

export interface XcodeDefaults {
  teams: AppleTeam[];
  /** Xcode's Organization Identifier, the prefix it suggests for new Bundle IDs. */
  bundleIdentifierPrefix?: string;
}

function exportXcodeDefaults(): Buffer | undefined {
  const exported = Bun.spawnSync(["defaults", "export", "com.apple.dt.Xcode", "-"], {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 10_000,
  });
  return exported.exitCode === 0 ? exported.stdout : undefined;
}

// Extracting one key at a time keeps a value JSON can't express elsewhere in the plist from failing the read.
// plutil's `json` format needs a collection, so strings use `raw`.
function extract(plist: Buffer, key: string, format: "json" | "raw"): unknown {
  const extracted = Bun.spawnSync(["plutil", "-extract", key, format, "-o", "-", "-"], {
    stdin: plist,
    stdout: "pipe",
    stderr: "ignore",
    timeout: 10_000,
  });
  if (extracted.exitCode !== 0) return undefined;
  const output = extracted.stdout.toString();
  return format === "json" ? JSON.parse(output) : output.trim();
}

/** Parses Xcode's `IDEProvisioningTeamByIdentifier`: teams keyed by signed-in account. */
export function parseTeams(value: unknown, lastSelected?: string): AppleTeam[] {
  if (value == null || typeof value !== "object") return [];
  const teams = new Map<string, AppleTeam>();
  for (const entries of Object.values(value)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const id = typeof entry?.teamID === "string" ? entry.teamID : "";
      if (!TEAM_ID.test(id) || teams.has(id)) continue;
      teams.set(id, {
        id,
        name: typeof entry.teamName === "string" && entry.teamName ? entry.teamName : id,
        personal: entry.isFreeProvisioningTeam === true,
      });
    }
  }
  // Paid teams first, since only they support every capability setup adds; then Xcode's last choice.
  return [...teams.values()].sort(
    (a, b) =>
      Number(a.personal) - Number(b.personal) ||
      Number(b.id === lastSelected) - Number(a.id === lastSelected) ||
      a.name.localeCompare(b.name),
  );
}

/** The teams and Organization Identifier from Xcode's settings, read without changing them. */
export function readXcodeDefaults(): XcodeDefaults {
  if (process.platform !== "darwin") return { teams: [] };
  try {
    const plist = exportXcodeDefaults();
    if (!plist) return { teams: [] };
    const lastSelected = extract(plist, "IDEProvisioningTeamManagerLastSelectedTeamID", "raw");
    const prefix = extract(plist, "IDETemplateOptions.bundleIdentifierPrefix", "raw");
    return {
      teams: parseTeams(
        extract(plist, "IDEProvisioningTeamByIdentifier", "json"),
        typeof lastSelected === "string" ? lastSelected : undefined,
      ),
      bundleIdentifierPrefix:
        typeof prefix === "string" && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/.test(prefix)
          ? prefix
          : undefined,
    };
  } catch (error) {
    log.debug(`Could not read Xcode settings: ${String(error)}`);
    return { teams: [] };
  }
}

/** Why setup leaves Associated Domains out for a macOS app signed by a Personal Team. */
export const PERSONAL_MAC_TEAM_DOMAIN_NOTE =
  "Associated Domains were left out: a Personal Team can't sign a macOS app that uses them. Sign-in with email codes and passwords works; passkeys and password AutoFill need a paid Apple Developer Program team. After switching to one, run clerk init again to add them.";

/** Why setup leaves Sign in with Apple out for an app signed by a Personal Team, even when Clerk enables it. */
export const PERSONAL_TEAM_APPLE_NOTE =
  "Sign in with Apple is enabled for this Clerk instance, but a Personal Team can't use it, so its capability was left out and Apple sign-in won't work in this app. It needs a paid Apple Developer Program team; after switching to one, run clerk init again.";

/** The inspected configurations a Personal Team signs. */
export interface PersonalSigning {
  configurations: string[];
  /** Other inspected configurations are signed by another team. */
  mixed: boolean;
}

/**
 * Which inspected configurations are signed by a team Xcode's account list calls a Personal
 * Team. A Personal Team can't use Sign in with Apple on any platform. A macOS app also can't
 * keep Associated Domains: it has no simulator to fall back to, so it's signed with a
 * provisioning profile, and a Personal Team can't provision them. iOS keeps them, since
 * simulator builds sign locally.
 *
 * Callers apply the limits to the whole app when any configuration is affected: configurations
 * usually share one entitlements file, and Clerk's Apple setting covers every build.
 */
export function personalSigningTeam(
  inspection: Inspection,
  teams?: AppleTeam[],
): PersonalSigning | undefined {
  const ids = inspection.contexts.map((context) => context.settings.DEVELOPMENT_TEAM ?? "");
  // No team, nothing to look up in Xcode's settings.
  if (!ids.some(Boolean)) return undefined;
  const personal = new Set(
    (teams ?? readXcodeDefaults().teams).filter((team) => team.personal).map((team) => team.id),
  );
  const configurations = inspection.contexts
    .filter((_, index) => personal.has(ids[index]!))
    .map((context) => context.selection.configuration);
  if (!configurations.length) return undefined;
  return { configurations, mixed: configurations.length !== inspection.contexts.length };
}

/** When only some configurations use a Personal Team, why the others get its limits too. */
export function personalTeamScopeNote(signing: PersonalSigning): string | undefined {
  if (!signing.mixed) return undefined;
  const [first, ...rest] = signing.configurations;
  const names = rest.length ? `${signing.configurations.join(", ")} are` : `${first} is`;
  return `${names} signed by a Personal Team and other configurations by another team, so the Personal Team's limits apply to the whole app. To use these capabilities in the others, give each configuration its own entitlements file in Xcode, or sign every configuration with a paid team.`;
}

/** An entitlements file still holds capabilities its Personal Team can't sign. */
export function personalTeamConflictNote(path: string, conflicts: string[]): string {
  return `${path} still has ${conflicts.join(" and ")}, which a Personal Team can't sign. Remove ${conflicts.length > 1 ? "them" : "it"} in Xcode's Signing & Capabilities, or switch to a paid Apple Developer Program team.`;
}
