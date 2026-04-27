import { resolveBapiSecretKey } from "../../lib/bapi-command.ts";
import { dim, cyan } from "../../lib/color.ts";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { isInsideGutter, log } from "../../lib/log.ts";
import { isAgent, isHuman } from "../../mode.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { bapiRequest } from "../api/bapi.ts";
import { resolveUsersInstanceContext } from "./interactive/instance-context.ts";
import { registerUsersAction } from "./registry.ts";

type UsersListOptions = {
  json?: boolean;
  secretKey?: string;
  app?: string;
  instance?: string;
  limit?: number;
  offset?: number;
  query?: string;
  emailAddress?: string[];
  phoneNumber?: string[];
  username?: string[];
  userId?: string[];
  externalId?: string[];
  orderBy?: string;
};

type UserIdentifier = { id?: string; email_address?: string; phone_number?: string };

type BapiUser = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  primary_email_address_id?: string | null;
  primary_phone_number_id?: string | null;
  email_addresses?: UserIdentifier[];
  phone_numbers?: UserIdentifier[];
};

type PaginatedUsersResponse = {
  data?: unknown;
  totalCount?: number;
};

const COLUMN_PADDING = 2;

function printJson(data: unknown, options: UsersListOptions = {}): boolean {
  if (!options.json && !isAgent()) return false;
  log.data(JSON.stringify(data, null, 2));
  return true;
}

function appendMultiValueParam(
  searchParams: URLSearchParams,
  key: string,
  values?: string[],
): void {
  if (!values?.length) return;

  for (const value of values) {
    for (const part of value.split(",")) {
      const trimmed = part.trim();
      if (trimmed) searchParams.append(key, trimmed);
    }
  }
}

function buildUsersListPath(options: UsersListOptions): string {
  const searchParams = new URLSearchParams();

  if (typeof options.limit === "number") {
    searchParams.set("limit", String(options.limit));
  }
  if (typeof options.offset === "number") {
    searchParams.set("offset", String(options.offset));
  }
  if (options.query?.trim()) {
    searchParams.set("query", options.query.trim());
  }
  if (options.orderBy?.trim()) {
    searchParams.set("order_by", options.orderBy.trim());
  }

  appendMultiValueParam(searchParams, "email_address", options.emailAddress);
  appendMultiValueParam(searchParams, "phone_number", options.phoneNumber);
  appendMultiValueParam(searchParams, "username", options.username);
  appendMultiValueParam(searchParams, "user_id", options.userId);
  appendMultiValueParam(searchParams, "external_id", options.externalId);

  const query = searchParams.toString();
  return query ? `/users?${query}` : "/users";
}

function userDisplayName(user: BapiUser): string {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return fullName || user.username || primaryIdentifier(user) || user.id;
}

function primaryIdentifier(user: BapiUser): string {
  const primaryEmail = user.email_addresses?.find(
    (email) => email.id && email.id === user.primary_email_address_id,
  );
  if (primaryEmail?.email_address) return primaryEmail.email_address;

  const firstEmail = user.email_addresses?.find((email) => email.email_address);
  if (firstEmail?.email_address) return firstEmail.email_address;

  const primaryPhone = user.phone_numbers?.find(
    (phone) => phone.id && phone.id === user.primary_phone_number_id,
  );
  if (primaryPhone?.phone_number) return primaryPhone.phone_number;

  const firstPhone = user.phone_numbers?.find((phone) => phone.phone_number);
  if (firstPhone?.phone_number) return firstPhone.phone_number;

  if (user.username) return user.username;

  return user.id;
}

function formatUsersTable(users: BapiUser[]): void {
  const nameWidth =
    Math.max("NAME".length, ...users.map((user) => userDisplayName(user).length)) + COLUMN_PADDING;
  const idWidth =
    Math.max("USER ID".length, ...users.map((user) => user.id.length)) + COLUMN_PADDING;

  // Inside an intro/outro block, route rows to stderr so the gutter prefix is
  // applied. Direct invocations still get the table on stdout for piping.
  const emit = isInsideGutter()
    ? (line: string) => log.info(line)
    : (line: string) => log.data(line);

  emit(
    `${dim("NAME".padEnd(nameWidth))}${dim("USER ID".padEnd(idWidth))}${dim("PRIMARY IDENTIFIER")}`,
  );

  for (const user of users) {
    const name = cyan(userDisplayName(user).padEnd(nameWidth));
    const id = dim(user.id.padEnd(idWidth));
    emit(`${name}${id}${primaryIdentifier(user)}`);
  }
}

async function resolveListSecretKey(options: UsersListOptions): Promise<string> {
  try {
    return await resolveBapiSecretKey({
      secretKey: options.secretKey,
      app: options.app,
      instance: options.instance,
    });
  } catch (error) {
    // Mirror `users create`: when there is no link, no env var, and no
    // targeting flags, fall back to the shared picker-aware resolver in human
    // mode so the user can choose an application interactively. With an
    // explicit target the user already chose where to operate; surface the
    // original error instead of silently switching applications.
    const hasExplicitTarget =
      Boolean(options.secretKey) ||
      Boolean(options.app) ||
      Boolean(options.instance) ||
      Boolean(process.env.CLERK_SECRET_KEY);

    if (
      isHuman() &&
      !hasExplicitTarget &&
      error instanceof CliError &&
      error.code === ERROR_CODE.NO_SECRET_KEY
    ) {
      const ctx = await resolveUsersInstanceContext({});
      return ctx.secretKey;
    }
    throw error;
  }
}

export async function list(options: UsersListOptions = {}): Promise<void> {
  const secretKey = await resolveListSecretKey(options);
  const response = await withSpinner("Fetching users...", () =>
    bapiRequest({
      method: "GET",
      path: buildUsersListPath(options),
      secretKey,
    }),
  );

  const body = response.body;
  const users = Array.isArray(body)
    ? (body as BapiUser[])
    : Array.isArray((body as PaginatedUsersResponse | undefined)?.data)
      ? ((body as PaginatedUsersResponse).data as BapiUser[])
      : [];
  const totalCount =
    typeof (body as PaginatedUsersResponse | undefined)?.totalCount === "number"
      ? (body as PaginatedUsersResponse).totalCount
      : users.length;

  const jsonBody = Array.isArray(body) ? users : body;
  if (printJson(jsonBody, options)) return;

  if (users.length === 0) {
    log.warn("No users found.");
    return;
  }

  formatUsersTable(users);
  log.info(`\n${totalCount} user${totalCount === 1 ? "" : "s"}`);
}

registerUsersAction({
  key: "list",
  label: "List users",
  description: "List users with filters and pagination",
  handler: async (targeting) => {
    await list(targeting);
  },
});
