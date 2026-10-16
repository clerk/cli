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

/**
 * The Personal Team signing a macOS app, if that's what Xcode's account list says it is. A
 * macOS app has no simulator to fall back to, so it has to be signed with a provisioning
 * profile, and a Personal Team can't provision Associated Domains. iOS keeps them: simulator
 * builds sign locally.
 */
export function personalMacTeam(
  inspection: Inspection,
  teams?: AppleTeam[],
): AppleTeam | undefined {
  if (!inspection.contexts.every((context) => context.selection.sdk === "macosx")) return undefined;
  const ids = new Set(
    inspection.contexts.map((context) => context.settings.DEVELOPMENT_TEAM ?? ""),
  );
  if (ids.size !== 1) return undefined;
  const [id] = ids;
  // Read Xcode's account list only for a macOS app.
  return (teams ?? readXcodeDefaults().teams).find((team) => team.id === id && team.personal);
}
