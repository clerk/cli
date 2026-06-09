import { webhooksGet } from "./get.ts";
import { webhooksList } from "./list.ts";

export const webhooks = {
  list: webhooksList,
  get: webhooksGet,
};
