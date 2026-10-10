/**
 * Cross-platform "open this URL in the user's browser" helper.
 *
 * Used by the auth login OAuth flow.
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

import { observeHostCapabilityFailure, withBrowserLaunch } from "./host-execution.ts";

/** Outcome of an `openBrowser` call. */
export type OpenResult =
  | { ok: true; launcher: string }
  | { ok: false; reason: "no-launcher" | "spawn-failed" };

/**
 * Candidate browser-launcher binaries per platform, in preference order.
 * The first one that exists on PATH wins.
 */
const LAUNCHERS: Record<NodeJS.Platform, readonly string[]> = {
  darwin: ["open"],
  win32: ["start"],
  linux: ["xdg-open", "gnome-open", "kde-open", "sensible-browser"],
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
 * Launcher chain for WSL (Windows Subsystem for Linux), where the goal is to
 * reach the *Windows host's* browser, not a Linux one:
 *
 *  1. `wslview` (from wslu) — purpose-built for this, but not always installed
 *  2. `powershell.exe` — present on PATH in every default WSL install via
 *     Windows interop (/mnt/c/...); `Start-Process <url>` opens the host's
 *     default browser
 *  3. `xdg-open` and friends — last resort, useful under WSLg with a Linux
 *     browser installed
 *
 * `explorer.exe` is deliberately absent: it opens URLs fine but always exits
 * with code 1, which our fast-non-zero-exit failure detection would misread
 * as a launch failure.
 */
const WSL_LAUNCHERS = ["wslview", "powershell.exe", ...LAUNCHERS.linux] as const;

/**
 * WSL2 sets `WSL_DISTRO_NAME` and `WSL_INTEROP`; as a fallback (older WSL1,
 * sanitized environments) the kernel version string in /proc/version
 * contains "microsoft".
 */
async function isWsl(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(await Bun.file("/proc/version").text());
  } catch {
    return false;
  }
}

/**
 * Build the spawn command for a given launcher.
 *
 * - `start` (Windows): invoked via cmd.exe. The entire command is passed as a
 *   single string after `/c` so that cmd.exe parses it exactly as if typed at
 *   the prompt: `start "" "https://..."`. The empty `""` is the window title
 *   (otherwise `start` interprets a quoted URL as the title), and the URL is
 *   quoted so `&` in OAuth query strings is not treated as a cmd.exe command
 *   separator.
 * - `powershell.exe` (WSL interop): `Start-Process '<url>'` with the URL in
 *   single quotes so `&` is not treated as a PowerShell operator; embedded
 *   single quotes are doubled per PowerShell quoting rules.
 */
function launchCommand(launcher: string, url: string): string[] {
  if (launcher === "start") return ["cmd.exe", "/c", `start "" "${url}"`];
  if (launcher === "powershell.exe") {
    return [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Start-Process '${url.replace(/'/g, "''")}'`,
    ];
  }
  return [launcher, url];
}

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
  const candidates = (await isWsl())
    ? WSL_LAUNCHERS
    : (LAUNCHERS[process.platform] ?? ["xdg-open"]);

  // Pick the first launcher that's actually installed. `start` is a cmd.exe
  // builtin (not a real binary on PATH), so we treat it as always-available
  // when present in the candidate list (Bun.which would always return null
  // for it). Everything else is checked normally.
  const launcher = candidates.find((bin) => bin === "start" || Bun.which(bin) !== null);
  if (!launcher) {
    return { ok: false, reason: "no-launcher" };
  }

  const command = launchCommand(launcher, url);

  try {
    const result = await withBrowserLaunch(
      { operation: "open", target: url, label: launcher },
      async () => {
        const proc = Bun.spawn(command, {
          // Detach so the parent process (clerk CLI) can exit without waiting
          // for the browser to close.
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
          // Prevent Bun from escaping the quotes inside the cmd.exe command string.
          windowsVerbatimArguments: launcher === "start",
        });

        // Race the launcher's exit against a short grace period. Real launchers
        // (open, xdg-open, wslview, cmd start) hand off to the OS and exit within
        // a few ms, so the common case is either:
        //   - exit code 0 before the timer fires -> clear success
        //   - still running after 150ms -> effectively success, fire-and-forget
        // The case we care about catching is a fast non-zero exit, which happens
        // in headless/misconfigured environments (e.g. xdg-open with no DISPLAY).
        // Without this we'd return ok:true and the caller would skip printing the
        // fallback URL, leaving auth login to hang on the OAuth callback.
        const GRACE_MS = 150;
        const outcome = await Promise.race([
          proc.exited.then(
            (code) => ({ kind: "exited" as const, code }),
            () => ({ kind: "failed" as const }),
          ),
          new Promise<{ kind: "running" }>((resolve) =>
            setTimeout(() => resolve({ kind: "running" }), GRACE_MS),
          ),
        ]);

        if (outcome.kind === "failed" || (outcome.kind === "exited" && outcome.code !== 0)) {
          observeHostCapabilityFailure("browser-launch", new Error("spawn-failed"), {
            operation: "open",
            target: url,
            label: launcher,
          });
          return { ok: false as const, reason: "spawn-failed" as const };
        }

        // Still running (or exited cleanly). Swallow any later rejection so it
        // doesn't surface as an unhandled promise rejection after the CLI moves on.
        proc.exited.catch(() => {});
        return { ok: true as const, launcher };
      },
    );

    return result;
  } catch {
    return { ok: false as const, reason: "spawn-failed" };
  }
}
