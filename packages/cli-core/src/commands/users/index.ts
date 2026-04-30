import { create } from "./create.ts";
import { list } from "./list.ts";
import { usersMenu } from "./menu.ts";
import { open } from "./open.ts";

export type { UsersActionTargeting, UsersAction } from "./registry.ts";
export {
  registerUsersAction,
  listUsersActions,
  __resetUsersActionRegistryForTesting,
} from "./registry.ts";

export const users = {
  create,
  list,
  menu: usersMenu,
  open,
};
