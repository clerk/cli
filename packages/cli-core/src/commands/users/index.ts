import { create } from "./create.ts";
import { remove } from "./delete.ts";
import { ban } from "./ban.ts";
import { unban } from "./unban.ts";
import { lock } from "./lock.ts";
import { unlock } from "./unlock.ts";
import { usersMenu } from "./menu.ts";

export type { UsersActionTargeting, UsersAction } from "./registry.ts";
export {
  registerUsersAction,
  listUsersActions,
  __resetUsersActionRegistryForTesting,
} from "./registry.ts";

export const users = {
  create,
  remove,
  ban,
  unban,
  lock,
  unlock,
  menu: usersMenu,
};
