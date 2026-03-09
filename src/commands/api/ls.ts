/**
 * `clerk api ls [filter]` — list available API endpoints.
 */

import { loadCatalog, filterEndpoints, type EndpointInfo } from "./catalog.ts";

export async function apiLs(
  filter: string | undefined,
  options: { platform?: boolean },
): Promise<void> {
  const catalog = await loadCatalog({ platform: options.platform });
  const endpoints = filterEndpoints(catalog, filter);

  if (endpoints.length === 0) {
    console.error(
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
  console.error(`\n${label}`);
}

function printTable(endpoints: EndpointInfo[]): void {
  const methodWidth = 8;
  const pathWidth = Math.min(Math.max(...endpoints.map((e) => e.path.length)) + 2, 50);

  for (const ep of endpoints) {
    const method = ep.method.padEnd(methodWidth);
    const path = ep.path.padEnd(pathWidth);
    console.log(`${method}${path}${ep.summary}`);
  }
}
