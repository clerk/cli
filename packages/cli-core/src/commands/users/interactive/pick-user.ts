import { search, Separator } from "../../../lib/listage.ts";
import { type BapiUserSummary, searchUsers } from "../../../lib/users.ts";

export type PickUserOptions = {
  secretKey: string;
  message?: string;
};

const PICKER_LIMIT = 20;

export function formatUserChoice(user: BapiUserSummary): string {
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
      const allUsers = await searchUsers(
        options.secretKey,
        { query: term ?? "" },
        PICKER_LIMIT + 1,
      );
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
