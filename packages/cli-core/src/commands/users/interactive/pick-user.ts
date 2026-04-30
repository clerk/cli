import { search } from "../../../lib/listage.ts";
import { bapiRequest } from "../../api/bapi.ts";

export type PickUserOptions = {
  secretKey: string;
  message?: string;
};

type UserSummary = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  email_addresses?: Array<{ email_address?: string }> | null;
};

type PaginatedUsersResponse = {
  data?: unknown;
  totalCount?: number;
};

export function formatUserChoice(user: UserSummary): string {
  const email = user.email_addresses?.[0]?.email_address ?? "no email";
  const nameParts = [user.first_name, user.last_name].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  const name =
    nameParts.length > 0
      ? nameParts.join(" ")
      : user.username || (email !== "no email" ? email : user.id);
  return `${name} (${email}) — ${user.id}`;
}

export async function pickUser(options: PickUserOptions): Promise<string> {
  return search<string>({
    message: options.message ?? "Pick a user:",
    source: async (term) => {
      const query = term ? `?query=${encodeURIComponent(term)}&limit=20` : "?limit=20";
      const response = await bapiRequest({
        method: "GET",
        path: `/users${query}`,
        secretKey: options.secretKey,
      });
      const body = response.body;
      const users = Array.isArray(body)
        ? (body as UserSummary[])
        : Array.isArray((body as PaginatedUsersResponse | undefined)?.data)
          ? ((body as PaginatedUsersResponse).data as UserSummary[])
          : [];

      return users.map((user) => ({
        value: user.id,
        name: formatUserChoice(user),
      }));
    },
  });
}
