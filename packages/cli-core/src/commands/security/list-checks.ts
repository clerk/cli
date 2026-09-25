import { log } from "../../lib/log.ts";
import { isAgent } from "../../mode.ts";
import { CHECKS } from "./catalog.ts";
import { formatCatalogHuman, formatCatalogJson } from "./format.ts";

export function securityChecks(options: { json?: boolean } = {}): void {
  if (options.json || isAgent()) {
    log.data(formatCatalogJson(CHECKS));
    return;
  }
  for (const line of formatCatalogHuman(CHECKS)) log.info(line);
  log.info("Run `clerk security audit` to evaluate the linked instance.");
}
