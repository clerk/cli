import type { Need } from "../../lib/deps.ts";

export type LogoutDeps = Need<{
  credentialStore: "deleteToken";
  configStore: "clearAuth";
  log: "info";
}>;

export async function logout(deps: LogoutDeps): Promise<void> {
  await deps.credentialStore.deleteToken();
  await deps.configStore.clearAuth();
  deps.log.info("Logged out successfully");
}
