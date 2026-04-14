/**
 * Browser collaborator.
 *
 * Wraps the platform-specific "open this URL in the user's default browser"
 * operation. Subprocess I/O is routed through the injected System so tests
 * can assert the spawn command without patching Bun globals.
 */

import type { System } from "./system.ts";

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

export function createBrowser(system: System): Browser {
  return {
    async open(url) {
      const cmd = OPEN_COMMAND[process.platform];
      if (!cmd) {
        return { ok: false, reason: `unsupported platform: ${process.platform}` };
      }
      try {
        const proc = system.spawn([...cmd, url], { stdout: "ignore", stderr: "ignore" });
        const exitCode = await proc.exited;
        if (exitCode !== 0) return { ok: false, reason: `exit code ${exitCode}` };
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
