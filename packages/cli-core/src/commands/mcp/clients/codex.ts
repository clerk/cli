/**
 * Codex reads `$CODEX_HOME/config.toml`, defaulting to `~/.codex/config.toml`
 * (`[mcp_servers.<name>] url = …`).
 *
 * Removal is delegated to `codex mcp remove <name>` (Codex's config is global,
 * no scope flag). The add is not: `codex mcp add <name> --url <url>` saves the
 * entry and then, for an OAuth server like Clerk's, starts a browser login and
 * blocks on its callback — which can't complete under our closed-stdin,
 * time-limited CLI runs. So the add appends the table to `config.toml`
 * directly (a text append; the user's comments and formatting survive), and
 * the user signs in afterwards with `codex mcp login`.
 */

import { makeCliClient } from "./make-cli-client.ts";
import { makeTomlClient, urlField } from "./make-client.ts";
import { codexHomePath } from "./paths.ts";
import { appendTomlTable } from "./toml-config.ts";

const configPath = (): string => codexHomePath("config.toml");
const TOP_KEY = "mcp_servers";
const encode = (url: string) => ({ url });

const codexFileClient = makeTomlClient({
  id: "codex",
  displayName: "Codex",
  scope: "user",
  activation: (name) => `Run \`codex mcp login ${name}\` to sign in to Clerk, then restart Codex.`,
  topKey: TOP_KEY,
  encode,
  extractUrl: urlField("url"),
  configPath,
});

export const codexClient = makeCliClient({
  base: codexFileClient,
  binary: "codex",
  installHint: "Install the Codex CLI: https://github.com/openai/codex",
  addEntry: async ({ name, url }) => appendTomlTable(configPath(), [TOP_KEY, name], encode(url)),
  removeArgs: (name) => ["mcp", "remove", name],
});
