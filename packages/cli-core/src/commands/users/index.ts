import { create } from "./create.ts";
import { metadata } from "./metadata.ts";
import { profileImage } from "./profile-image.ts";
import { password } from "./password.ts";
import { mfa } from "./mfa.ts";
import { usersMenu } from "./menu.ts";

export type { UsersActionTargeting, UsersAction } from "./registry.ts";
export {
  registerUsersAction,
  listUsersActions,
  __resetUsersActionRegistryForTesting,
} from "./registry.ts";

export const users = {
  create,
  metadata,
  profileImage,
  password,
  mfa,
  menu: usersMenu,
};
