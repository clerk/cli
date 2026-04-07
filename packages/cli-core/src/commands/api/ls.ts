/**
 * `clerk api ls [filter]` — list available API endpoints.
 */

import type { Need } from "../../lib/deps.ts";
import { loadCatalog, filterEndpoints, type EndpointInfo } from "./catalog.ts";

export type ApiLsDeps = Need<{
  spinner: "withSpinner";
  log: "info" | "data" | "warn";
}>;

export async function apiLs(
  deps: ApiLsDeps,
  filter: string | undefined,
  options: { platform?: boolean },
): Promise<void> {
  const catalog = await loadCatalog(deps, { platform: options.platform });
  const endpoints = filterEndpoints(catalog, filter);

  if (endpoints.length === 0) {
    deps.log.info(
      filter
        ? `No endpoints matching "${filter}". Try a broader search term.`
        : "No endpoints found.",
    );
    return;
  }

  printTable(deps, endpoints);

  const label = filter
    ? `${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"} matching "${filter}"`
    : `${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"}`;
  deps.log.info(`\n${label}`);
}

function printTable(deps: Need<{ log: "data" }>, endpoints: EndpointInfo[]): void {
  const methodWidth = 8;
  const pathWidth = Math.min(Math.max(...endpoints.map((e) => e.path.length)) + 2, 50);

  for (const ep of endpoints) {
    const method = ep.method.padEnd(methodWidth);
    const path = ep.path.padEnd(pathWidth);
    deps.log.data(`${method}${path}${ep.summary}`);
  }
}
