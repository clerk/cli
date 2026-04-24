import { resolveBapiSecretKey } from "../../lib/bapi-command.ts";
import { cyan, dim } from "../../lib/color.ts";
import { log } from "../../lib/log.ts";
import { isAgent } from "../../mode.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { bapiRequest } from "../api/bapi.ts";

type UsersReadOptions = {
  json?: boolean;
  secretKey?: string;
  app?: string;
  instance?: string;
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

function printJson(data: unknown, options: UsersReadOptions = {}): boolean {
  if (!options.json && !isAgent()) return false;
  log.data(JSON.stringify(data, null, 2));
  return true;
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

export async function get(userId: string, options: UsersReadOptions = {}): Promise<void> {
  const secretKey = await resolveBapiSecretKey({
    secretKey: options.secretKey,
    app: options.app,
    instance: options.instance,
  });
  const response = await withSpinner("Fetching user...", () =>
    bapiRequest({
      method: "GET",
      path: `/users/${userId}`,
      secretKey,
    }),
  );

  const user = response.body as BapiUser;

  if (printJson(user, options)) return;

  log.data(`User ${cyan(userDisplayName(user))} ${dim(user.id)}`);
  log.data(`Primary identifier: ${primaryIdentifier(user)}`);
  if (user.username) {
    log.data(`Username: ${user.username}`);
  }
}
