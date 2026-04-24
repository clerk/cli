import { create } from "./create.ts";
import { update } from "./update.ts";
import { usersMenu } from "./menu.ts";

export type { UsersActionTargeting, UsersAction } from "./registry.ts";
export {
  registerUsersAction,
  listUsersActions,
  __resetUsersActionRegistryForTesting,
} from "./registry.ts";

export const users = {
  create,
  update,
  menu: usersMenu,
};
