import { BapiError } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { isAgent } from "../../mode.ts";

export type UsersOutputOptions = {
  json?: boolean;
};

export function shouldPrintUsersJson(options: UsersOutputOptions = {}): boolean {
  return Boolean(options.json || isAgent());
}

export function printUsersResponseBody(body: unknown): void {
  if (typeof body === "string") {
    if (body) {
      log.data(body);
    }
    return;
  }

  if (typeof body === "undefined" || body === null) {
    return;
  }

  log.data(JSON.stringify(body, null, 2));
}

export function printUsersJson(body: unknown, options: UsersOutputOptions = {}): boolean {
  if (!shouldPrintUsersJson(options)) {
    return false;
  }

  printUsersResponseBody(body);
  return true;
}

export function printUsersMutationResult(
  action: string,
  body: unknown,
  options: UsersOutputOptions = {},
): void {
  if (printUsersJson(body, options)) {
    return;
  }

  const userId = getUserId(body);
  log.success(userId ? `${action} ${userId}` : action);
}

export function printUsersMutationSuccess(
  message: string,
  body: unknown,
  options: UsersOutputOptions = {},
): void {
  if (printUsersJson(body, options)) {
    return;
  }

  log.success(message);
}

export function handleUsersBapiError(
  error: unknown,
  context: string,
  options: UsersOutputOptions = {},
): boolean {
  if (!(error instanceof BapiError)) {
    return false;
  }

  if (shouldPrintUsersJson(options)) {
    printUsersResponseBody(parseUsersErrorBody(error.body));
  } else {
    log.error(`${context}: ${formatUsersErrorBody(error.body)}`);
  }

  process.exitCode = 1;
  return true;
}

function getUserId(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  const { id } = body as { id?: unknown };
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function parseUsersErrorBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function formatUsersErrorBody(body: string): string {
  const parsed = parseUsersErrorBody(body);

  if (typeof parsed === "string") {
    return parsed.length > 200 ? `${parsed.slice(0, 200)}...` : parsed;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "Request failed";
  }

  const { errors, error, message } = parsed as {
    errors?: Array<{ message?: unknown }>;
    error?: unknown;
    message?: unknown;
  };

  if (Array.isArray(errors) && errors.length > 0) {
    return errors
      .map((entry) =>
        typeof entry?.message === "string" && entry.message.length > 0
          ? entry.message
          : "Unknown error",
      )
      .join("\n");
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  if (typeof message === "string" && message.length > 0) {
    return message;
  }

  return "Request failed";
}
