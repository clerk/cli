/**
 * `clerk api ls [filter]` — list available API endpoints. A filter that is an
 * endpoint path (`/users`) also prints the request body fields of the
 * endpoints at exactly that path.
 */

import { loadCatalog, filterEndpoints, type EndpointInfo } from "./catalog.ts";
import { log } from "../../lib/log.ts";

export async function apiLs(
  filter: string | undefined,
  options: { platform?: boolean },
): Promise<void> {
  const catalog = await loadCatalog({ platform: options.platform });
  const path = filter?.startsWith("/") ? normalizeCatalogPath(filter) : undefined;
  const endpoints = filterEndpoints(catalog, path ?? filter);

  if (endpoints.length === 0) {
    log.info(
      filter
        ? `No endpoints matching "${filter}". Try a broader search term.`
        : "No endpoints found.",
    );
    return;
  }

  printTable(endpoints, path);

  const label = filter
    ? `${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"} matching "${filter}"`
    : `${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"}`;
  log.info(`\n${label}`);
}

/**
 * Catalog paths carry no `/v1` prefix, while request paths may (see
 * `normalizeBapiPath`), so drop it along with a trailing slash.
 */
function normalizeCatalogPath(path: string): string {
  const stripped = path.replace(/^\/v1(?=\/|$)/, "").replace(/(.)\/+$/, "$1");
  return stripped || "/";
}

const METHOD_WIDTH = 8;

function printTable(endpoints: EndpointInfo[], detailPath: string | undefined): void {
  const pathWidth = Math.min(Math.max(...endpoints.map((e) => e.path.length)) + 2, 50);

  for (const ep of endpoints) {
    const method = ep.method.padEnd(METHOD_WIDTH);
    // padEnd is a no-op once the path meets/exceeds pathWidth, so guarantee a
    // separator for over-long paths instead of gluing the summary onto them.
    const path = ep.path.length >= pathWidth ? `${ep.path}  ` : ep.path.padEnd(pathWidth);
    log.data(`${method}${path}${ep.summary}`);
    if (ep.path === detailPath) printRequestBody(ep);
  }
}

function printRequestBody(ep: EndpointInfo): void {
  const body = ep.requestBody;
  if (!body) return;

  const indent = " ".repeat(METHOD_WIDTH);
  const details = [body.contentType, body.type === "object" ? "" : body.type];
  if (body.required) details.push("required");
  log.data(`${indent}Body (${details.filter(Boolean).join(", ")}):`);

  const nameWidth = Math.max(...body.fields.map((f) => f.name.length)) + 2;
  const typeWidth = Math.max(...body.fields.map((f) => f.type.length)) + 2;
  for (const field of body.fields) {
    const columns = [
      field.name.padEnd(nameWidth),
      field.type.padEnd(typeWidth),
      (field.required ? "required" : "").padEnd(10),
      field.description,
    ];
    log.data(`${indent}  ${columns.join("")}`.trimEnd());
  }
}
