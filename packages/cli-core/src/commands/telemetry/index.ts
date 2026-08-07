import type { Program } from "../../cli-program.ts";
import { setTelemetryDisabled } from "../../lib/config.ts";
import { getTelemetryStatus, type TelemetryStatus } from "../../lib/telemetry.ts";
import { log } from "../../lib/log.ts";
import { isAgent } from "../../mode.ts";

function describeDisabledReason(status: Exclude<TelemetryStatus, { enabled: true }>): string {
  switch (status.reason) {
    case "env":
      return `Disabled by the \`${status.envVar}\` environment variable.`;
    case "config":
      return "Disabled via `clerk telemetry disable`. Re-enable with `clerk telemetry enable`.";
    case "dev-build":
      return "Disabled automatically for dev builds (`0.0.0-dev`).";
  }
}

export async function telemetryStatus(): Promise<void> {
  const status = await getTelemetryStatus();
  if (isAgent()) {
    log.data(JSON.stringify(status));
    return;
  }
  log.data(`Telemetry is ${status.enabled ? "enabled" : "disabled"}`);
  if (status.enabled) {
    log.info("Opt out with `clerk telemetry disable` (or `CLERK_TELEMETRY_DISABLED=1`).");
  } else {
    log.info(describeDisabledReason(status));
  }
}

export async function telemetryDisable(): Promise<void> {
  await setTelemetryDisabled(true);
  log.success("Telemetry disabled. Nothing will be sent from this machine.");
}

export async function telemetryEnable(): Promise<void> {
  await setTelemetryDisabled(false);
  log.success("Telemetry enabled.");
  const status = await getTelemetryStatus();
  if (!status.enabled && status.reason === "env") {
    log.warn(`\`${status.envVar}\` is still set — telemetry stays disabled until it is unset.`);
  }
}

export function registerTelemetry(program: Program): void {
  const telemetry = program
    .command("telemetry")
    .description("Control CLI usage telemetry (status, disable, enable)");

  telemetry
    .command("status")
    .description("Show whether telemetry is enabled and why")
    .setExamples([
      { command: "clerk telemetry status", description: "Show the current telemetry state" },
    ])
    .action(telemetryStatus);

  telemetry
    .command("disable")
    .description("Disable telemetry for this machine (persisted)")
    .setExamples([
      { command: "clerk telemetry disable", description: "Opt out of usage telemetry" },
    ])
    .action(telemetryDisable);

  telemetry
    .command("enable")
    .description("Re-enable telemetry for this machine")
    .setExamples([
      { command: "clerk telemetry enable", description: "Opt back in to usage telemetry" },
    ])
    .action(telemetryEnable);
}
