import { webhooksEventTypes } from "./event-types.ts";
import { webhooksGet } from "./get.ts";
import { webhooksList } from "./list.ts";

export const webhooks = {
  list: webhooksList,
  get: webhooksGet,
  eventTypes: webhooksEventTypes,
};
