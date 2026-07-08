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
  forwardTo: string;
}

/** NDJSON ready line (stdout in agent/--json mode). */
export function buildReadyLine(info: ReadyInfo): string {
  return JSON.stringify({
    type: "ready",
    relay_url: info.relayUrl,
    forward_to: info.forwardTo,
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
  log.ui(
    [
      "",
      `${bold("Webhook relay ready")}`,
      `  URL:             ${info.relayUrl}`,
      `  Forwarding to:   ${info.forwardTo}`,
      `  Verification:    ${dim("off (no signing secret; verify with your Dashboard endpoint secret)")}`,
      "",
      `  ${dim("Add this Relay URL as an endpoint in the Clerk Dashboard to receive real events:")}`,
      `    ${cyan(info.relayUrl)}`,
      `  ${dim("Open the Dashboard webhooks page to add it:")}`,
      `    ${cyan("https://dashboard.clerk.com/last-active?path=webhooks")}`,
      `  ${dim("Or POST any JSON to the Relay URL above to inject a test delivery.")}`,
      `  ${dim("Press Ctrl+C to stop.")}`,
      "",
      "",
    ].join("\n"),
  );
}

/**
 * Shown after the ready banner when `listen` ran WITHOUT `--token`: the relay
 * token was auto-generated and isn't guaranteed stable (it can differ across
 * machines, a cleared config, or a rare token collision). Nudge toward pinning
 * a fixed, shareable URL — ideally the current one, so it never moves.
 */
export function renderUnpinnedTokenHint(token: string): void {
  log.ui(
    yellow("  ! Using an auto-generated relay token — it can change across machines,\n") +
      yellow("    a cleared config, or a rare token collision.\n") +
      dim("    To lock this exact URL, always pass --token:\n") +
      dim(`      clerk webhooks listen --token ${token} --forward-to <url>\n`) +
      dim("    Generate a fresh token anytime with: clerk webhooks token\n\n"),
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
        dim(`    Fix the handler, then re-trigger the event (delivery ${svixId}).\n`),
    );
  }
}
