/**
 * Registry of supported MCP clients. Order is the display order in the
 * human-mode multiselect picker.
 */

import { claudeClient } from "./claude.ts";
import { codexClient } from "./codex.ts";
import { cursorClient } from "./cursor.ts";
import { geminiClient } from "./gemini.ts";
import { hermesClient } from "./hermes.ts";
import { openclawClient } from "./openclaw.ts";
import { opencodeClient } from "./opencode.ts";
import type { ClientId, McpClient } from "./types.ts";
import { vscodeClient } from "./vscode.ts";
import { warpClient } from "./warp.ts";
import { windsurfClient } from "./windsurf.ts";

export const CLIENTS: readonly McpClient[] = [
  claudeClient,
  cursorClient,
  vscodeClient,
  windsurfClient,
  geminiClient,
  codexClient,
  opencodeClient,
  openclawClient,
  warpClient,
  hermesClient,
];

export const CLIENT_IDS: readonly ClientId[] = CLIENTS.map((c) => c.id);

/**
 * Accepted `--client` aliases → canonical id. GitHub Copilot runs inside VS
 * Code and shares its `mcp.json`, so `copilot` and `vscode` target the same
 * client.
 */
export const CLIENT_ALIASES: Readonly<Record<string, ClientId>> = { copilot: "vscode" };

export const CLIENT_ID_CHOICES: readonly string[] = [...CLIENT_IDS, ...Object.keys(CLIENT_ALIASES)];

export async function detectInstalledClients(cwd: string): Promise<McpClient[]> {
  const flags = await Promise.all(CLIENTS.map((c) => c.detect(cwd)));
  return CLIENTS.filter((_, i) => flags[i]);
}
