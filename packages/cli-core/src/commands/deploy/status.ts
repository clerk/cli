import { PlapiError } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import {
  getApplicationDomainStatus,
  triggerApplicationDomainDNSCheck,
  type DomainStatusResponse,
} from "../../lib/plapi.ts";
import { sleep } from "../../lib/sleep.ts";
import type { SpinnerControls } from "../../lib/spinner.ts";
import {
  DEPLOY_COMPONENT_ORDER,
  deployComponentLabels,
  deployStatusRetryMessage,
  type DeployComponent,
  type DeployComponentStatus,
} from "./copy.ts";
import { mapDeployError } from "./errors.ts";

const DEPLOY_STATUS_INITIAL_RETRY_DELAY_MS = 3000;
const DEPLOY_STATUS_MAX_RETRIES = 5;
const DEPLOY_STATUS_BACKOFF_FACTOR = 2;

export interface DeployProgressHandlers {
  runComponent<T>(
    component: DeployComponent,
    progressLabel: string,
    work: (controls: SpinnerControls) => Promise<T>,
  ): Promise<T>;
  onComponentDone?(component: DeployComponent): void;
}

export type DeployStatusOutcome = { verified: boolean; status: DeployComponentStatus };

export async function waitForDeployStatus(
  appId: string,
  domainIdOrName: string,
  domain: string,
  handlers: DeployProgressHandlers,
): Promise<DeployStatusOutcome> {
  await triggerDeployStatusCheck(appId, domainIdOrName);
  let response = await mapDeployError(getApplicationDomainStatus(appId, domainIdOrName));
  let status = deployComponentStatusFromDomainStatus(response);
  for (const component of DEPLOY_COMPONENT_ORDER) {
    let retriesRemaining = DEPLOY_STATUS_MAX_RETRIES;
    let nextRetryDelay = DEPLOY_STATUS_INITIAL_RETRY_DELAY_MS;
    const labels = deployComponentLabels(component, domain);
    const flipped = await handlers.runComponent(component, labels.progress, async (spinner) => {
      if (status[component]) return true;
      while (retriesRemaining > 0) {
        await sleepWithRetryCountdown(
          labels.progress,
          DEPLOY_STATUS_MAX_RETRIES - retriesRemaining + 1,
          DEPLOY_STATUS_MAX_RETRIES,
          nextRetryDelay,
          spinner,
        );
        retriesRemaining--;
        nextRetryDelay *= DEPLOY_STATUS_BACKOFF_FACTOR;
        response = await mapDeployError(getApplicationDomainStatus(appId, domainIdOrName));
        status = deployComponentStatusFromDomainStatus(response);
        if (status[component]) return true;
      }
      return false;
    });
    if (!flipped) return { verified: false, status };
    handlers.onComponentDone?.(component);
  }

  if (response.status !== "complete") {
    return { verified: false, status };
  }
  return { verified: true, status };
}

async function sleepWithRetryCountdown(
  message: string,
  currentRetry: number,
  totalRetries: number,
  delayMs: number,
  spinner: SpinnerControls,
): Promise<void> {
  let remainingMs = delayMs;
  while (remainingMs > 0) {
    const tickMs = Math.min(1000, remainingMs);
    spinner.update(
      deployStatusRetryMessage(message, currentRetry, totalRetries, Math.ceil(remainingMs / 1000)),
    );
    await sleep(tickMs);
    remainingMs -= tickMs;
  }
}

async function triggerDeployStatusCheck(appId: string, domainIdOrName: string): Promise<void> {
  try {
    await mapDeployError(triggerApplicationDomainDNSCheck(appId, domainIdOrName));
  } catch (error) {
    if (error instanceof PlapiError && error.status === 409 && error.code === "conflict") {
      log.debug("DNS check is already in flight; continuing to poll domain status.");
      return;
    }
    throw error;
  }
}

export function deployComponentStatusFromDomainStatus(
  response: DomainStatusResponse,
): DeployComponentStatus {
  return {
    dns: checkStatusComplete(response.dns),
    ssl: checkStatusComplete(response.ssl),
    mail: checkStatusComplete(response.mail),
  };
}

function checkStatusComplete(check: { status: string; required?: boolean } | undefined): boolean {
  if (!check) return false;
  if (check.required === false) return true;
  return check.status === "complete";
}
