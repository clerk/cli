import { search, Separator } from "../../../lib/listage.ts";
import { bapiRequest } from "../../api/bapi.ts";

export type PickUserOptions = {
  secretKey: string;
  message?: string;
};

const PICKER_LIMIT = 20;

type UserSummary = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  email_addresses?: Array<{ email_address?: string }> | null;
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
      // Request one extra so we can flag overflow with a refine-search hint.
      const params = new URLSearchParams();
      if (term) params.set("query", term);
      params.set("limit", String(PICKER_LIMIT + 1));
      const response = await bapiRequest({
        method: "GET",
        path: `/users?${params}`,
        secretKey: options.secretKey,
      });
      const body = response.body;
      const allUsers = Array.isArray(body) ? (body as UserSummary[]) : [];
      const hasMore = allUsers.length > PICKER_LIMIT;
      const users = hasMore ? allUsers.slice(0, PICKER_LIMIT) : allUsers;

      const choices: Array<{ value: string; name: string } | Separator> = users.map((user) => ({
        value: user.id,
        name: formatUserChoice(user),
      }));

      if (hasMore) {
        choices.push(new Separator("More results available, type to refine your search"));
      }

      return choices;
    },
  });
}
