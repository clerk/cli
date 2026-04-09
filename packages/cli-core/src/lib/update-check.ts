import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isAgent } from "../mode.ts";
import { yellow, cyan } from "./color.ts";
import {
  CACHE_TTL_MS,
  NPM_REGISTRY_URL,
  UPDATE_PACKAGE_NAME,
  UPDATE_CACHE_FILE,
} from "./constants.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type UpdateCache = {
  checkedAt: number;
  latest: string;
  distTag: string;
};

// ── Channel ───────────────────────────────────────────────────────────────────

export function getUpdateChannel(): string {
  return process.env.CLERK_UPDATE_CHANNEL ?? "latest";
}

// ── Version helpers ───────────────────────────────────────────────────────────

export function getCurrentVersion(): string {
  return typeof CLI_VERSION !== "undefined" ? CLI_VERSION : "0.0.0-dev";
}

export function isDevVersion(version: string): boolean {
  return version === "0.0.0-dev";
}

function parseSemver(version: string): [number, number, number, string] {
  const dashIndex = version.indexOf("-");
  const base = dashIndex === -1 ? version : version.slice(0, dashIndex);
  const pre = dashIndex === -1 ? "" : version.slice(dashIndex + 1);
  const parts = base.split(".");
  return [Number(parts[0]) || 0, Number(parts[1]) || 0, Number(parts[2]) || 0, pre];
}

export function compareSemver(a: string, b: string): number {
  const [aMaj, aMin, aPat, aPre] = parseSemver(a);
  const [bMaj, bMin, bPat, bPre] = parseSemver(b);

  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  if (aPat !== bPat) return aPat - bPat;
  if (aPre === bPre) return 0;
  if (!aPre) return 1; // 1.0.0 > 1.0.0-alpha
  if (!bPre) return -1; // 1.0.0-alpha < 1.0.0

  const aNum = Number(aPre.split(".").at(-1));
  const bNum = Number(bPre.split(".").at(-1));
  if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
  return aPre.localeCompare(bPre);
}

// ── Guards ────────────────────────────────────────────────────────────────────

export function shouldCheckForUpdates(version: string): boolean {
  if (isAgent()) return false;
  if (isDevVersion(version)) return false;
  if (process.env.CI) return false;
  if (process.env.NO_UPDATE_NOTIFIER) return false;
  if (process.env.CLERK_NO_UPDATE_CHECK) return false;
  return true;
}

// ── Cache I/O ─────────────────────────────────────────────────────────────────

function isUpdateCache(value: unknown): value is UpdateCache {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.checkedAt === "number" && typeof v.latest === "string" && typeof v.distTag === "string"
  );
}

export async function readUpdateCache(): Promise<UpdateCache | null> {
  try {
    const file = Bun.file(UPDATE_CACHE_FILE);
    if (!(await file.exists())) return null;
    const data = await file.json();
    return isUpdateCache(data) ? data : null;
  } catch {
    return null;
  }
}

export async function writeUpdateCache(data: UpdateCache): Promise<void> {
  try {
    await mkdir(dirname(UPDATE_CACHE_FILE), { recursive: true });
    await Bun.write(UPDATE_CACHE_FILE, JSON.stringify(data));
  } catch {
    // never crash the CLI on cache write failure
  }
}

function isCacheValid(cache: UpdateCache, distTag: string): boolean {
  return cache.distTag === distTag && Date.now() - cache.checkedAt < CACHE_TTL_MS;
}

// ── Registry ──────────────────────────────────────────────────────────────────

type NpmDistTagsResponse = { "dist-tags": Record<string, string> };

function isNpmDistTagsResponse(value: unknown): value is NpmDistTagsResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v["dist-tags"] === "object" && v["dist-tags"] !== null;
}

export async function fetchLatestVersion(distTag: string, timeoutMs = 1500): Promise<string> {
  const url = `${NPM_REGISTRY_URL}${encodeURIComponent(UPDATE_PACKAGE_NAME)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.npm.install-v1+json" },
    });
    if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
    const data: unknown = await res.json();
    if (!isNpmDistTagsResponse(data)) throw new Error("unexpected registry response shape");
    const version = data["dist-tags"][distTag];
    if (!version) throw new Error(`dist-tag "${distTag}" not found`);
    return version;
  } finally {
    clearTimeout(timer);
  }
}

// ── Notification ──────────────────────────────────────────────────────────────

export function formatChannelFlag(channel: string): string {
  return channel !== "latest" ? ` --channel ${channel}` : "";
}

export function formatChannelLabel(channel: string): string {
  return channel !== "latest" ? ` (${channel})` : "";
}

function formatUpdateBanner(
  currentVersion: string,
  latestVersion: string,
  distTag: string,
): string {
  const channelFlag = formatChannelFlag(distTag);
  return [
    "",
    yellow(`  ⬆  Update available: ${currentVersion} → ${latestVersion}`),
    `     Run: ${cyan(`clerk update${channelFlag}`)}`,
    `     Disable: ${cyan("CLERK_NO_UPDATE_CHECK=1")}`,
    "",
  ].join("\n");
}

function notifyIfNewer(currentVersion: string, latestVersion: string, distTag: string): void {
  if (compareSemver(latestVersion, currentVersion) > 0) {
    process.stderr.write(formatUpdateBanner(currentVersion, latestVersion, distTag));
  }
}

export async function maybeNotifyUpdate(currentVersion: string): Promise<void> {
  if (!shouldCheckForUpdates(currentVersion)) return;

  const distTag = getUpdateChannel();
  const cache = await readUpdateCache();

  if (cache && isCacheValid(cache, distTag)) {
    notifyIfNewer(currentVersion, cache.latest, distTag);
    return;
  }

  // Cache stale or missing — fetch fresh, write cache, notify if needed
  try {
    const latest = await fetchLatestVersion(distTag);
    await writeUpdateCache({ checkedAt: Date.now(), latest, distTag });
    notifyIfNewer(currentVersion, latest, distTag);
  } catch {
    // silent failure — never crash the CLI on update check issues
  }
}
