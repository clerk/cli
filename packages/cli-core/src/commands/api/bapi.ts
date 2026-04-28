/**
 * Backend API (BAPI) client.
 * Thin HTTP wrapper for Clerk's Backend API endpoints.
 */

import { getBapiBaseUrl } from "../../lib/environment.ts";
import { normalizeBapiPath } from "../../lib/bapi-command.ts";
import { BapiError } from "../../lib/errors.ts";
import { loggedFetch } from "../../lib/fetch.ts";

export interface BapiResponse {
  status: number;
  headers: Headers;
  body: unknown;
  rawBody: string;
}

export async function bapiRequest(options: {
  method: string;
  path: string;
  secretKey: string;
  body?: string;
  baseUrl?: string;
}): Promise<BapiResponse> {
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

  const rawBody = await response.text();

  if (!response.ok) {
    throw new BapiError(response.status, rawBody, response.headers);
  }

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
