/**
 * `clerk api ls [filter]` — list available API endpoints.
 */

import { loadCatalog, filterEndpoints, type EndpointInfo } from "./catalog.ts";
import { log } from "../../lib/log.ts";

export async function apiLs(
  filter: string | undefined,
  options: { platform?: boolean },
): Promise<void> {
  const catalog = await loadCatalog({ platform: options.platform });
  const endpoints = filterEndpoints(catalog, filter);

  if (endpoints.length === 0) {
    log.info(
      filter
        ? `No endpoints matching "${filter}". Try a broader search term.`
        : "No endpoints found.",
    );
    return;
  }

  printTable(endpoints);

  const label = filter
    ? `${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"} matching "${filter}"`
    : `${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"}`;
  log.info(`\n${label}`);
}

function printTable(endpoints: EndpointInfo[]): void {
  const methodWidth = 8;
  const pathWidth = Math.min(Math.max(...endpoints.map((e) => e.path.length)) + 2, 50);

  for (const ep of endpoints) {
    const method = ep.method.padEnd(methodWidth);
    // padEnd is a no-op once the path meets/exceeds pathWidth, so guarantee a
    // separator for over-long paths instead of gluing the summary onto them.
    const path = ep.path.length >= pathWidth ? `${ep.path}  ` : ep.path.padEnd(pathWidth);
    log.data(`${method}${path}${ep.summary}`);
  }
}
