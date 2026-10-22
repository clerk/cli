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

let cachedDefaults: XcodeDefaults | undefined;

/**
 * The teams and Organization Identifier from Xcode's settings, read without changing them. Read
 * once per command: it starts several processes, and starter, setup, and doctor all need it.
 */
export function readXcodeDefaults(): XcodeDefaults {
  cachedDefaults ??= loadXcodeDefaults();
  return cachedDefaults;
}

function loadXcodeDefaults(): XcodeDefaults {
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

/** Whether a team signing the app is one Xcode's account list marks as a Personal Team. */
export function signedByPersonalTeam(inspection: Inspection, teams?: AppleTeam[]): boolean {
  const ids = new Set(inspection.contexts.map((context) => context.settings.DEVELOPMENT_TEAM));
  ids.delete(undefined);
  if (!ids.size) return false;
  return (teams ?? readXcodeDefaults().teams).some((team) => team.personal && ids.has(team.id));
}
