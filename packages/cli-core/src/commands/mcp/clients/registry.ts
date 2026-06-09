/**
 * Registry of supported MCP clients. Order is the display order in the
 * human-mode multiselect picker.
 */

import { claudeClient } from "./claude.ts";
import { cursorClient } from "./cursor.ts";
import { geminiClient } from "./gemini.ts";
import type { ClientId, McpClient } from "./types.ts";
import { vscodeClient } from "./vscode.ts";
import { windsurfClient } from "./windsurf.ts";

export const CLIENTS: readonly McpClient[] = [
  claudeClient,
  cursorClient,
  vscodeClient,
  windsurfClient,
  geminiClient,
];

export const CLIENT_IDS: readonly ClientId[] = CLIENTS.map((c) => c.id);

export async function detectInstalledClients(cwd: string): Promise<McpClient[]> {
  const flags = await Promise.all(CLIENTS.map((c) => c.detect(cwd)));
  return CLIENTS.filter((_, i) => flags[i]);
}
