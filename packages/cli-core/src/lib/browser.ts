/**
 * Browser collaborator.
 *
 * Wraps the platform-specific "open this URL in the user's default browser"
 * operation so commands can route browser launches through `deps.browser.open`
 * instead of importing `Bun.spawn` directly.
 */

export interface OpenResult {
  ok: boolean;
  reason?: string;
}

export interface Browser {
  open(url: string): Promise<OpenResult>;
}

const OPEN_COMMAND: Record<NodeJS.Platform, string[] | undefined> = {
  darwin: ["open"],
  linux: ["xdg-open"],
  win32: ["cmd", "/c", "start", '""'],
} as Record<NodeJS.Platform, string[] | undefined>;

async function openUrl(url: string): Promise<OpenResult> {
  const cmd = OPEN_COMMAND[process.platform];
  if (!cmd) {
    return { ok: false, reason: `unsupported platform: ${process.platform}` };
  }
  try {
    const proc = Bun.spawn([...cmd, url], { stdout: "ignore", stderr: "ignore" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return { ok: false, reason: `exit code ${exitCode}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export const browser: Browser = {
  open: openUrl,
};
