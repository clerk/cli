/**
 * Rendering for `webhooks listen`. Per-delivery lines go through
 * `log.ui(line + "\n")` — every other stderr channel shares a 5-then-suppress
 * throttle per 1s window that would eat delivery bursts.
 */

import { bold, cyan, dim, green, red, yellow } from "../../lib/color.ts";
import { log } from "../../lib/log.ts";
import type { ForwardOutcome } from "./forward.ts";

export interface ReadyInfo {
  relayUrl: string;
  signingSecret: string;
  endpointId: string;
  eventsFilter: string[] | null;
  forwardTo: string | null;
}

/** NDJSON ready line (stdout in agent/--json mode). */
export function buildReadyLine(info: ReadyInfo): string {
  return JSON.stringify({
    type: "ready",
    relay_url: info.relayUrl,
    signing_secret: info.signingSecret,
    endpoint_id: info.endpointId,
    events_filter: info.eventsFilter,
  });
}

/** NDJSON per-delivery line; saved to a file it feeds `verify --delivery`. */
export function buildEventLine(args: {
  svixId: string;
  eventType: string;
  headers: Record<string, string>;
  bodyB64: string;
  forwardStatus: number | null;
  latencyMs: number;
}): string {
  return JSON.stringify({
    type: "event",
    svix_id: args.svixId,
    event_type: args.eventType,
    headers: args.headers,
    body_b64: args.bodyB64,
    forward_status: args.forwardStatus,
    latency_ms: args.latencyMs,
  });
}

export function renderReadyBanner(info: ReadyInfo): void {
  const forwarding = info.forwardTo ?? dim("(not forwarding — printing events only)");
  const events = info.eventsFilter?.length ? info.eventsFilter.join(", ") : "all";
  log.ui(
    [
      "",
      `${bold("Webhook relay ready")}`,
      `  Endpoint:        ${cyan(info.endpointId)}`,
      `  Relay URL:       ${info.relayUrl}`,
      `  Signing secret:  ${info.signingSecret}`,
      `                   ${dim("(local relay endpoint secret, NOT your Dashboard endpoint secret)")}`,
      `  Forwarding to:   ${forwarding}`,
      `  Events:          ${events}`,
      "",
      `  ${dim("Press Ctrl+C to stop. The relay endpoint and secret persist across restarts.")}`,
      "",
      "",
    ].join("\n"),
  );
}

function timeOfDay(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function renderArrival(eventType: string, svixId: string): void {
  log.ui(`${dim(timeOfDay())} ${cyan("-->")} ${eventType} ${dim(svixId)}\n`);
}

export function renderForwardResult(outcome: ForwardOutcome, method: string, path: string): void {
  const color = outcome.status >= 500 ? red : outcome.status >= 400 ? yellow : green;
  log.ui(
    `${dim(timeOfDay())} ${color(`<-- ${outcome.status}`)} ${method} ${path} ${dim(`${outcome.latencyMs}ms`)}\n`,
  );
}

export function renderVerificationWarning(svixId: string): void {
  log.ui(
    yellow(
      `  ! signature verification failed for ${svixId} — the relay secret does not match this delivery. Forwarding anyway; pass --skip-verify to silence.\n`,
    ),
  );
}

const BODY_PREVIEW_LIMIT = 500;

export function renderForwardDiagnostics(outcome: ForwardOutcome, svixId: string): void {
  if (outcome.failed) {
    log.ui(
      yellow(`  ! could not reach the local handler: ${outcome.bodyText}\n`) +
        dim("    Is your dev server running on the --forward-to URL?\n"),
    );
    return;
  }

  if (outcome.status === 401) {
    log.ui(
      yellow("  ! 401 from your handler — middleware is likely protecting the webhook route.\n") +
        dim(
          "    In clerkMiddleware(), allow it with createRouteMatcher(['/api/webhooks(.*)']) as a public route.\n",
        ),
    );
    return;
  }

  if (outcome.status === 400) {
    log.ui(
      yellow("  ! 400 from your handler — usually a signature check on a parsed body.\n") +
        dim(
          "    Pass the RAW request body to verifyWebhook(); read it before any JSON body parsing.\n",
        ),
    );
    return;
  }

  if (outcome.status >= 500) {
    const preview =
      outcome.bodyText.length > BODY_PREVIEW_LIMIT
        ? `${outcome.bodyText.slice(0, BODY_PREVIEW_LIMIT)}...`
        : outcome.bodyText;
    log.ui(
      yellow(`  ! ${outcome.status} from your handler. Response body:\n`) +
        (preview ? `    ${preview}\n` : dim("    (empty)\n")) +
        dim(`    Fix the handler, then resend this delivery: clerk webhooks replay ${svixId}\n`),
    );
  }
}
