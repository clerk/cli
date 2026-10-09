/**
 * Writes opencode's user-global `opencode.json` directly (XDG config dir on
 * every platform). opencode ships an `mcp add` command, but it is an
 * interactive wizard — under our closed-stdin guarantee it would EOF-error —
 * and there is no removal command at all, so both mutations use the
 * documented manual path: the config file.
 *
 * opencode's dialect: entries live under top-level `mcp`, and a remote server
 * is `{ type: "remote", url }`. opencode runs the OAuth sign-in itself.
 */

import { makeJsonClient, urlField } from "./make-client.ts";
import { pathExists, xdgConfigPath } from "./paths.ts";

export const opencodeClient = makeJsonClient({
  id: "opencode",
  displayName: "opencode",
  scope: "user",
  activation: (name) =>
    `Restart opencode and sign in to Clerk when prompted (or run \`opencode mcp auth ${name}\`).`,
  topKey: "mcp",
  encode: (url) => ({ type: "remote", url }),
  extractUrl: urlField("url"),
  configPath: () => xdgConfigPath("opencode", "opencode.json"),
  detect: async () => pathExists(xdgConfigPath("opencode")),
});
