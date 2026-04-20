import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import semver from "semver";
import { isAgent } from "../mode.ts";
import {
  CACHE_TTL_MS,
  NPM_REGISTRY_URL,
  UPDATE_PACKAGE_NAME,
  UPDATE_CACHE_FILE,
} from "./constants.ts";
import { loggedFetch } from "./fetch.ts";
import { log } from "./log.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type UpdateCache = {
  checkedAt: number;
  latest: string;
  distTag: string;
};

// ── Channel ───────────────────────────────────────────────────────────────────

export function inferChannelFromVersion(version: string): string {
  const dashIndex = version.indexOf("-");
  if (dashIndex === -1) return "latest";
  const pre = version.slice(dashIndex + 1);
  const dotIndex = pre.indexOf(".");
  return dotIndex === -1 ? pre : pre.slice(0, dotIndex);
}

export function getUpdateChannel(): string {
  if (process.env.CLERK_UPDATE_CHANNEL) return process.env.CLERK_UPDATE_CHANNEL;
  return inferChannelFromVersion(getCurrentVersion());
}

// ── Version helpers ───────────────────────────────────────────────────────────

export function getCurrentVersion(): string {
  return typeof CLI_VERSION !== "undefined" ? CLI_VERSION : "0.0.0-dev";
}

export function isDevVersion(version: string): boolean {
  return version === "0.0.0-dev";
}

export function compareSemver(a: string, b: string): number {
  return semver.compare(a, b);
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
  } catch (error) {
    log.debug(`Failed to read update cache: ${error}`);
    return null;
  }
}

export async function writeUpdateCache(data: UpdateCache): Promise<void> {
  try {
    await mkdir(dirname(UPDATE_CACHE_FILE), { recursive: true });
    await Bun.write(UPDATE_CACHE_FILE, JSON.stringify(data));
  } catch (error) {
    log.debug(`Failed to write update cache: ${error}`);
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
    const res = await loggedFetch(url, {
      tag: "update-check",
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

function notifyIfNewer(currentVersion: string, latestVersion: string, distTag: string): void {
  if (compareSemver(latestVersion, currentVersion) > 0) {
    const channelFlag = formatChannelFlag(distTag);
    log.blank();
    log.warn(`⬆  Update available: ${currentVersion} → ${latestVersion}`);
    log.info(`     Run: \`clerk update${channelFlag}\``);
    log.info(`     Disable: \`CLERK_NO_UPDATE_CHECK=1\``);
    log.blank();
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
  } catch (error) {
    log.debug(`Update check failed: ${error}`);
  }
}
