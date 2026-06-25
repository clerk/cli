import { createOption } from "@commander-js/extra-typings";
import type { Program } from "../../cli-program.ts";
import { getAuthToken } from "../../lib/plapi.ts";
import { parseIntegerOption } from "../../lib/option-parsers.ts";
import { webhooksCreate } from "./create.ts";
import { webhooksDelete } from "./delete.ts";
import { webhooksEventTypes } from "./event-types.ts";
import { webhooksGet } from "./get.ts";
import { webhooksList } from "./list.ts";
import { webhooksListen } from "./listen.ts";
import { webhooksMessages } from "./messages.ts";
import { webhooksOpen } from "./open.ts";
import { webhooksReplay } from "./replay.ts";
import { webhooksSecret } from "./secret.ts";
import { webhooksTrigger } from "./trigger.ts";
import { webhooksUpdate } from "./update.ts";
import { webhooksVerify } from "./verify.ts";

const webhooksHandlers = {
  list: webhooksList,
  get: webhooksGet,
  eventTypes: webhooksEventTypes,
  secret: webhooksSecret,
  delete: webhooksDelete,
  update: webhooksUpdate,
  create: webhooksCreate,
  messages: webhooksMessages,
  replay: webhooksReplay,
  trigger: webhooksTrigger,
  open: webhooksOpen,
  verify: webhooksVerify,
  listen: webhooksListen,
};

export function registerWebhooks(program: Program): void {
  const webhooks = program
    .command("webhooks")
    .description("Manage webhook endpoints and deliveries")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--json", "Output as JSON")
    .setExamples([
      { command: "clerk webhooks list", description: "List webhook endpoints" },
      {
        command: "clerk webhooks create --url https://example.com/api/webhooks",
        description: "Create an endpoint and print its signing secret",
      },
      {
        command: "clerk webhooks listen --forward-to http://localhost:3000/api/webhooks",
        description: "Forward instance events to a local handler",
      },
    ]);

  webhooks.hook("preAction", async (_thisCommand, actionCommand) => {
    if (actionCommand.name() === "verify") return; // pure offline HMAC, no auth gate
    // `listen --relay-only` is a standalone Svix Play tunnel — no instance
    // context, no PLAPI, no auth.
    if (
      actionCommand.name() === "listen" &&
      (actionCommand.opts() as { relayOnly?: boolean }).relayOnly
    ) {
      return;
    }
    await getAuthToken();
  });

  webhooks
    .command("list")
    .description("List webhook endpoints for the instance")
    .option("--limit <number>", "Maximum endpoints to return (1-250, default 100)", (value) =>
      parseIntegerOption(value, "--limit", { min: 1, max: 250 }),
    )
    .option("--iterator <cursor>", "Pagination cursor from the previous response")
    .setExamples([
      { command: "clerk webhooks list", description: "List webhook endpoints" },
      { command: "clerk webhooks list --limit 10", description: "List the first 10 endpoints" },
      {
        command: "clerk webhooks list --iterator iter_abc",
        description: "Fetch the next page using a previous response's cursor",
      },
    ])
    .action((_opts, cmd) =>
      webhooksHandlers.list(cmd.optsWithGlobals() as Parameters<typeof webhooksHandlers.list>[0]),
    );

  webhooks
    .command("get")
    .description("Show one webhook endpoint's configuration")
    .argument("<id>", "Webhook endpoint ID (ep_...)")
    .setExamples([
      { command: "clerk webhooks get ep_2abc123", description: "Show an endpoint's config" },
      {
        command: "clerk webhooks get ep_2abc123 --json",
        description: "Emit the endpoint resource as JSON",
      },
    ])
    .action((endpointId, _opts, cmd) =>
      webhooksHandlers.get({
        ...(cmd.optsWithGlobals() as Omit<
          Parameters<typeof webhooksHandlers.get>[0],
          "endpointId"
        >),
        endpointId,
      }),
    );

  webhooks
    .command("event-types")
    .description("List the instance's webhook event-type catalog")
    .option("--limit <number>", "Maximum event types to return (1-250, default 100)", (value) =>
      parseIntegerOption(value, "--limit", { min: 1, max: 250 }),
    )
    .option("--iterator <cursor>", "Pagination cursor from the previous response")
    .setExamples([
      { command: "clerk webhooks event-types", description: "List available event types" },
      {
        command: "clerk webhooks event-types --json",
        description: "Emit the catalog as JSON",
      },
    ])
    .action((_opts, cmd) =>
      webhooksHandlers.eventTypes(
        cmd.optsWithGlobals() as Parameters<typeof webhooksHandlers.eventTypes>[0],
      ),
    );

  webhooks
    .command("secret")
    .description("Print a webhook endpoint's signing secret")
    .argument("<id>", "Webhook endpoint ID (ep_...)")
    .option(
      "--rotate",
      "Rotate the signing secret first. The old key keeps verifying for 24h (Svix dual-signing grace).",
    )
    .option("--yes", "Skip the rotation confirmation prompt (required with --rotate in agent mode)")
    .setExamples([
      { command: "clerk webhooks secret ep_2abc123", description: "Print the signing secret" },
      {
        command: "export CLERK_WEBHOOK_SIGNING_SECRET=$(clerk webhooks secret ep_2abc123)",
        description: "Export the secret into the environment",
      },
      {
        command: "clerk webhooks secret ep_2abc123 --rotate",
        description: "Rotate, then print the new secret",
      },
    ])
    .action((endpointId, _opts, cmd) =>
      webhooksHandlers.secret({
        ...(cmd.optsWithGlobals() as Omit<
          Parameters<typeof webhooksHandlers.secret>[0],
          "endpointId"
        >),
        endpointId,
      }),
    );

  webhooks
    .command("delete")
    .description("Delete a webhook endpoint")
    .argument("<id>", "Webhook endpoint ID (ep_...)")
    .option("--yes", "Skip the confirmation prompt (required in agent mode)")
    .setExamples([
      { command: "clerk webhooks delete ep_2abc123", description: "Delete with confirmation" },
      {
        command: "clerk webhooks delete ep_2abc123 --yes",
        description: "Delete without prompting",
      },
    ])
    .action((endpointId, _opts, cmd) =>
      webhooksHandlers.delete({
        ...(cmd.optsWithGlobals() as Omit<
          Parameters<typeof webhooksHandlers.delete>[0],
          "endpointId"
        >),
        endpointId,
      }),
    );

  webhooks
    .command("update")
    .description("Update a webhook endpoint's configuration")
    .argument("<id>", "Webhook endpoint ID (ep_...)")
    .option("--url <url>", "New destination URL")
    .option(
      "--events <types>",
      'Comma-separated event types to filter on (e.g. user.created,user.deleted). Pass an empty value (--events "") to clear all filters',
    )
    .option("--description <text>", "New description")
    .option(
      "--channels <channels>",
      'Comma-separated channels. Pass an empty value (--channels "") to clear all channels',
    )
    .option("--enable", "Re-enable a disabled endpoint")
    .option("--disable", "Disable the endpoint")
    .setExamples([
      {
        command: "clerk webhooks update ep_2abc123 --url https://example.com/api/webhooks",
        description: "Point the endpoint at a new URL",
      },
      {
        command: "clerk webhooks update ep_2abc123 --events user.created,user.deleted",
        description: "Replace the event-type filter",
      },
      {
        command: "clerk webhooks update ep_2abc123 --enable",
        description: "Re-enable an endpoint",
      },
    ])
    .action((endpointId, _opts, cmd) =>
      webhooksHandlers.update({
        ...(cmd.optsWithGlobals() as Omit<
          Parameters<typeof webhooksHandlers.update>[0],
          "endpointId"
        >),
        endpointId,
      }),
    );

  webhooks
    .command("create")
    .description("Create a webhook endpoint and print its signing secret")
    .option("--url <url>", "Destination URL (required)")
    .option(
      "--events <types>",
      "Comma-separated event types to filter on (e.g. user.created,user.deleted)",
    )
    .option("--description <text>", "Endpoint description")
    .option("--channels <channels>", "Comma-separated channels")
    .option("--disabled", "Create the endpoint in a disabled state")
    .setExamples([
      {
        command: "clerk webhooks create --url https://example.com/api/webhooks",
        description: "Create an endpoint receiving all events",
      },
      {
        command:
          "clerk webhooks create --url https://example.com/api/webhooks --events user.created,user.deleted",
        description: "Create an endpoint filtered to specific events",
      },
      {
        command: "clerk webhooks create --url https://example.com/api/webhooks --disabled",
        description: "Create the endpoint disabled",
      },
    ])
    .action((_opts, cmd) =>
      webhooksHandlers.create(
        cmd.optsWithGlobals() as Parameters<typeof webhooksHandlers.create>[0],
      ),
    );

  webhooks
    .command("messages")
    .description("List recent deliveries for an endpoint (the feed for `webhooks replay`)")
    .option(
      "--endpoint <ep_id>",
      "Endpoint to inspect (defaults to this instance's relay endpoint from `webhooks listen`)",
    )
    .addOption(
      createOption("--status <status>", "Filter by delivery status").choices([
        "success",
        "pending",
        "fail",
        "sending",
      ]),
    )
    .option("--limit <number>", "Maximum deliveries to return (1-250, default 100)", (value) =>
      parseIntegerOption(value, "--limit", { min: 1, max: 250 }),
    )
    .option("--iterator <cursor>", "Pagination cursor from the previous response")
    .setExamples([
      {
        command: "clerk webhooks messages --endpoint ep_2abc123",
        description: "List recent deliveries for an endpoint",
      },
      {
        command: "clerk webhooks messages --status fail",
        description: "List failed deliveries on the relay endpoint",
      },
    ])
    .action((_opts, cmd) =>
      webhooksHandlers.messages(
        cmd.optsWithGlobals() as Parameters<typeof webhooksHandlers.messages>[0],
      ),
    );

  webhooks
    .command("replay")
    .description("Resend one delivery, or bulk-recover a time window of deliveries")
    .argument("[msg_id]", "Message ID to resend (mutually exclusive with --since)")
    .option(
      "--endpoint <ep_id>",
      "Target endpoint (defaults to the relay endpoint for <msg_id>; required with --since)",
    )
    .option("--since <ISO>", "Bulk-recover deliveries from this RFC 3339 timestamp")
    .option("--until <ISO>", "Optional end of the recovery window (requires --since)")
    .option("--yes", "Skip the bulk-recovery confirmation prompt (required in agent mode)")
    .setExamples([
      {
        command: "clerk webhooks replay msg_2xyz",
        description: "Resend one delivery to the relay endpoint",
      },
      {
        command: "clerk webhooks replay msg_2xyz --endpoint ep_2abc123",
        description: "Resend one delivery to a specific endpoint",
      },
      {
        command:
          "clerk webhooks replay --since 2026-05-01T00:00:00Z --until 2026-05-01T01:00:00Z --endpoint ep_2abc123",
        description: "Recover all deliveries in a bounded window",
      },
    ])
    .action((msgId, _opts, cmd) =>
      webhooksHandlers.replay({
        ...(cmd.optsWithGlobals() as Omit<Parameters<typeof webhooksHandlers.replay>[0], "msgId">),
        msgId,
      }),
    );

  webhooks
    .command("trigger")
    .description("Send an example event to an endpoint (validates the type first)")
    .argument("<event_type>", "Event type to trigger (e.g. user.created)")
    .option(
      "--endpoint <ep_id>",
      "Target endpoint (defaults to this instance's relay endpoint from `webhooks listen`)",
    )
    .setExamples([
      {
        command: "clerk webhooks trigger user.created",
        description: "Send an example user.created event to the relay endpoint",
      },
      {
        command: "clerk webhooks trigger user.created --endpoint ep_2abc123",
        description: "Send an example event to a specific endpoint",
      },
    ])
    .action((eventType, _opts, cmd) =>
      webhooksHandlers.trigger({
        ...(cmd.optsWithGlobals() as Omit<
          Parameters<typeof webhooksHandlers.trigger>[0],
          "eventType"
        >),
        eventType,
      }),
    );

  webhooks
    .command("open")
    .description("Open the instance's webhook portal in your browser")
    .setExamples([
      { command: "clerk webhooks open", description: "Open the webhook portal" },
      { command: "clerk webhooks open --json", description: "Print the portal URL as JSON" },
    ])
    .action((_opts, cmd) =>
      webhooksHandlers.open(cmd.optsWithGlobals() as Parameters<typeof webhooksHandlers.open>[0]),
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
    .setExamples([
      {
        command:
          "clerk webhooks verify --secret whsec_... --payload @body.json --id msg_2xyz --timestamp 1717935000 --signature v1,abc...",
        description: "Verify from the four header values",
      },
      {
        command: "clerk webhooks verify --secret whsec_... --delivery @event.json",
        description: "Verify a saved `listen` event line",
      },
    ])
    .action((_opts, cmd) =>
      webhooksHandlers.verify(
        cmd.optsWithGlobals() as Parameters<typeof webhooksHandlers.verify>[0],
      ),
    );

  webhooks
    .command("listen")
    .description("Stream instance events to your terminal and forward them to a local handler")
    .option("--forward-to <url>", "Local URL to POST deliveries to (omit to just print events)")
    .option(
      "--events <types>",
      "Comma-separated event types to filter on (PATCHes the shared relay endpoint's filter)",
    )
    .option("--skip-verify", "Skip HMAC verification of incoming deliveries")
    .option(
      "--relay-only",
      "Standalone tunnel: connect to the Svix relay and forward without registering a Clerk endpoint or fetching a secret (no auth, no backend; verification off)",
    )
    .option(
      "--token <c_token>",
      "Pin the relay token (only with --relay-only) so the inbox URL stays fixed. Format: c_ + 10 base62 chars",
    )
    .option(
      "--headers <pairs>",
      "Extra headers for the forwarded request, comma-separated k:v pairs (svix-* cannot be overridden)",
    )
    .setExamples([
      {
        command: "clerk webhooks listen --forward-to http://localhost:3000/api/webhooks",
        description: "Forward instance events to a local handler",
      },
      {
        command: "clerk webhooks listen --events user.created,user.deleted",
        description: "Only receive specific event types",
      },
      {
        command: "clerk webhooks listen --json",
        description: "Emit NDJSON event lines (pipe into a file for `webhooks verify --delivery`)",
      },
    ])
    .action((_opts, cmd) =>
      webhooksHandlers.listen(
        cmd.optsWithGlobals() as Parameters<typeof webhooksHandlers.listen>[0],
      ),
    );
}
