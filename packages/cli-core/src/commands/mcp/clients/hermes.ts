/**
 * Registration is delegated to the Hermes Agent CLI:
 * `hermes mcp add <name> --url <url> --auth oauth` and
 * `hermes mcp remove <name>`. The YAML base reads `~/.hermes/config.yaml`
 * (`mcp_servers.<name> = { url, auth: oauth }`) for `list`/`doctor` only;
 * YAML writes are refused (Hermes' CLI owns both mutations, and rewriting the
 * user's YAML would destroy comments).
 */

import { makeCliClient } from "./make-cli-client.ts";
import { makeYamlClient, urlField } from "./make-client.ts";
import { userPath } from "./paths.ts";

const hermesFileClient = makeYamlClient({
  id: "hermes",
  displayName: "Hermes Agent",
  scope: "user",
  activation: (name) =>
    `Run \`hermes mcp login ${name}\` to sign in to Clerk, then restart Hermes (or run \`/reload-mcp\` in a session).`,
  topKey: "mcp_servers",
  encode: (url) => ({ url, auth: "oauth" }),
  extractUrl: urlField("url"),
  configPath: () => userPath(".hermes", "config.yaml"),
});

export const hermesClient = makeCliClient({
  base: hermesFileClient,
  binary: "hermes",
  installHint: "Install Hermes Agent: https://hermes-agent.nousresearch.com",
  addArgs: ({ name, url }) => ["mcp", "add", name, "--url", url, "--auth", "oauth"],
  // Hermes' add probes the server, then ends in a confirm prompt ("Enable all
  // tools?" on success, "Save config anyway?" on failure) — and cancelling on
  // EOF exits 0 without saving. Pipe the affirmative answer, and verify the
  // entry actually landed since the exit code alone can't be trusted.
  addStdin: "y\n",
  verifyAdd: true,
  removeArgs: (name) => ["mcp", "remove", name],
});
