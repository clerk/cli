import { webhooksCreate } from "./create.ts";
import { webhooksDelete } from "./delete.ts";
import { webhooksEventTypes } from "./event-types.ts";
import { webhooksGet } from "./get.ts";
import { webhooksList } from "./list.ts";
import { webhooksSecret } from "./secret.ts";
import { webhooksUpdate } from "./update.ts";

export const webhooks = {
  list: webhooksList,
  get: webhooksGet,
  eventTypes: webhooksEventTypes,
  secret: webhooksSecret,
  delete: webhooksDelete,
  update: webhooksUpdate,
  create: webhooksCreate,
};
