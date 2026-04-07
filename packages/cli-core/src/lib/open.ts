/**
 * Cross-platform "open this URL in the user's browser" helper.
 *
 * Used by the auth login OAuth flow and by deploy's docs-link redirects.
 * Both call sites previously used `Bun.spawn(["open", url])` (macOS only)
 * or a small per-file lookup table that fell back to `xdg-open` blindly.
 * That fails hard on:
 *  - Headless Linux without xdg-utils installed
 *  - WSL (where xdg-open exists but doesn't actually launch the host browser)
 *  - Linux with only `xdg-open` symlinked to a broken handler
 *
 * This module:
 *  1. Picks an ordered list of candidate launchers per platform
 *  2. Filters them with `Bun.which()` to keep only the ones actually on PATH
 *  3. Spawns the first one that exists, with try/catch
 *  4. Returns a result indicating success / failure mode so callers can
 *     decide whether to print the URL as a fallback
 *
 * Callers are expected to handle the `failed` case by displaying the URL
 * to the user. For the auth flow that's critical, since the OAuth callback
 * cannot complete without the user reaching the URL.
 */

/** Outcome of an `openBrowser` call. */
export type OpenResult =
  | { ok: true; launcher: string }
  | { ok: false; reason: "no-launcher" | "spawn-failed" };

/**
 * Candidate browser-launcher binaries per platform, in preference order.
 * The first one that exists on PATH wins.
 *
 * Linux ordering rationale: `wslview` first because it correctly hands the
 * URL to the Windows host browser inside WSL (xdg-open inside WSL usually
 * fails or opens nothing). `xdg-open` is the standard Linux tool. The other
 * entries are direct browser binaries as last-ditch fallbacks.
 */
const LAUNCHERS: Record<NodeJS.Platform, readonly string[]> = {
  darwin: ["open"],
  win32: ["start"],
  linux: ["wslview", "xdg-open", "gnome-open", "kde-open", "sensible-browser"],
  // Other platforms (freebsd, openbsd, sunos, aix, android) get xdg-open as
  // a best guess.
  aix: ["xdg-open"],
  android: ["xdg-open"],
  freebsd: ["xdg-open"],
  haiku: ["xdg-open"],
  netbsd: ["xdg-open"],
  openbsd: ["xdg-open"],
  sunos: ["xdg-open"],
  cygwin: ["start"],
};

/**
 * Try to open `url` in the user's default browser.
 *
 * Never throws. Returns an {@link OpenResult} so the caller can fall back
 * to printing the URL if no launcher could be invoked.
 *
 * @example
 * ```ts
 * const result = await openBrowser("https://accounts.example.com/oauth");
 * if (!result.ok) {
 *   console.log(`Open this URL in your browser: ${url}`);
 * }
 * ```
 */
export async function openBrowser(url: string): Promise<OpenResult> {
  const candidates = LAUNCHERS[process.platform] ?? ["xdg-open"];

  // Pick the first launcher that's actually installed. `start` is a cmd.exe
  // builtin (not a real binary on PATH), so we treat it as always-available
  // when present in the candidate list (Bun.which would always return null
  // for it). Everything else is checked normally.
  const launcher = candidates.find((bin) => bin === "start" || Bun.which(bin) !== null);
  if (!launcher) {
    return { ok: false, reason: "no-launcher" };
  }

  // On Windows, invoke `start` via cmd.exe. The empty "" is the window title
  // (otherwise start would interpret a quoted URL as the title).
  const command = launcher === "start" ? ["cmd.exe", "/c", "start", "", url] : [launcher, url];

  try {
    const proc = Bun.spawn(command, {
      // Detach so the parent process (clerk CLI) can exit without waiting
      // for the browser to close.
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    // Don't await proc.exited; we just want to launch and continue. The
    // launcher hands off the URL and exits ~immediately, but the parent
    // (clerk CLI) shouldn't block on browser teardown. Attach a no-op catch
    // so a late rejection (e.g. launcher exited non-zero) doesn't surface
    // as an unhandled promise rejection.
    proc.exited.catch(() => {});
    return { ok: true, launcher };
  } catch {
    return { ok: false, reason: "spawn-failed" };
  }
}
