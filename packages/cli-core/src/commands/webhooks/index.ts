import type { Program } from "../../cli-program.ts";
import { webhooksListen } from "./listen.ts";
import { webhooksToken } from "./token.ts";
import { webhooksVerify } from "./verify.ts";

/**
 * V1 webhooks group: the PLAPI-free slice. `listen` is a standalone Svix relay
 * tunnel and `verify` is offline HMAC — both run with no auth, no instance
 * context, and no backend, so the group has no `preAction` auth gate.
 */
export function registerWebhooks(program: Program): void {
  const webhooks = program
    .command("webhooks")
    .description("Stream webhook events to a local handler and verify their signatures")
    .setExamples([
      {
        command: "clerk webhooks token",
        description: "1. Generate a stable relay token",
      },
      {
        command:
          'clerk webhooks listen --token "$(clerk webhooks token)" --forward-to http://localhost:3000/api/webhooks',
        description: "2. Stream events to a local handler on a pinned URL",
      },
      {
        command: "clerk webhooks verify --secret whsec_... --delivery @event.json",
        description: "3. Verify a delivery's signature offline",
      },
    ]);

  webhooks
    .command("token")
    .description("Generate a relay token (c_ + 10 base62 chars) for `listen --token`")
    .option("--json", 'Output as JSON ({ "token": "c_..." })')
    .setExamples([
      { command: "clerk webhooks token", description: "Print a fresh relay token" },
      {
        command: 'clerk webhooks listen --token "$(clerk webhooks token)"',
        description: "Generate and pin a token in one step",
      },
    ])
    .action((_opts, cmd) =>
      webhooksToken(cmd.optsWithGlobals() as Parameters<typeof webhooksToken>[0]),
    );

  webhooks
    .command("listen")
    .description("Stream webhook events to your terminal and forward them to a local handler")
    .option("--forward-to <url>", "Local URL to POST deliveries to (omit to just print events)")
    .option(
      "--token <c_token>",
      "Pin the relay token so the inbox URL stays fixed across restarts. Format: c_ + 10 base62 chars",
    )
    .option(
      "--headers <pairs>",
      "Extra headers for the forwarded request, comma-separated k:v pairs (svix-* cannot be overridden)",
    )
    .option("--json", "Output as NDJSON (agent/pipe mode)")
    .setExamples([
      {
        command: "clerk webhooks listen --forward-to http://localhost:3000/api/webhooks",
        description: "Forward webhook events to a local handler",
      },
      {
        command: "clerk webhooks listen --token c_AbCd123456",
        description: "Pin a stable relay inbox URL across restarts",
      },
      {
        command: "clerk webhooks listen --json",
        description: "Emit NDJSON event lines (pipe into a file for `webhooks verify --delivery`)",
      },
    ])
    .action((_opts, cmd) =>
      webhooksListen(cmd.optsWithGlobals() as Parameters<typeof webhooksListen>[0]),
    );

  webhooks
    .command("verify")
    .description("Verify a webhook signature locally (offline, no auth required)")
    .option("--secret <whsec>", "Signing secret (whsec_...), always required")
    .option(
      "--delivery <file>",
      "One `listen` event NDJSON line as @file or - for stdin (alternative to the four explicit flags)",
    )
    .option("--payload <file>", "Raw request body as @file or - for stdin")
    .option("--id <msg_id>", "The svix-id header value")
    .option("--timestamp <seconds>", "The svix-timestamp header value (Unix epoch seconds)")
    .option("--signature <sig>", "The raw svix-signature header value (may hold multiple entries)")
    .option("--json", "Output as JSON")
    .setExamples([
      {
        command: "clerk webhooks verify --secret whsec_... --delivery @event.json",
        description: "Verify a saved `listen` event line",
      },
      {
        command:
          "clerk webhooks verify --secret whsec_... --payload @body.json --id msg_2xyz --timestamp 1717935000 --signature v1,abc...",
        description: "Verify from the four header values",
      },
    ])
    .action((_opts, cmd) =>
      webhooksVerify(cmd.optsWithGlobals() as Parameters<typeof webhooksVerify>[0]),
    );
}
