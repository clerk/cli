/**
 * Backend API (BAPI) client.
 * Thin HTTP wrapper for Clerk's Backend API endpoints. Sibling to lib/fapi.ts.
 */

import { getBapiBaseUrl } from "./environment.ts";
import { normalizeBapiPath } from "./bapi-command.ts";
import { BapiError } from "./errors.ts";
import { loggedFetch, type ApiResponse } from "./fetch.ts";

export async function bapiRequest(options: {
  method: string;
  path: string;
  secretKey: string;
  body?: string;
  baseUrl?: string;
}): Promise<ApiResponse> {
  const base = options.baseUrl ?? getBapiBaseUrl();
  const path = normalizeBapiPath(options.path);

  const url = `${base}${path}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.secretKey}`,
    Accept: "application/json",
  };

  if (options.body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await loggedFetch(url, {
    tag: "bapi",
    method: options.method,
    headers,
    body: options.body,
  });

  if (!response.ok) {
    throw await BapiError.fromResponse(response);
  }

  const rawBody = await response.text();

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = rawBody;
  }

  return {
    status: response.status,
    headers: response.headers,
    body,
    rawBody,
  };
}
