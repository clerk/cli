import { mcpInstall } from "./install.ts";
import { mcpList } from "./list.ts";
import { mcpUninstall } from "./uninstall.ts";

export const mcp = {
  install: mcpInstall,
  list: mcpList,
  uninstall: mcpUninstall,
};
export { CLIENT_IDS } from "./clients/registry.ts";
