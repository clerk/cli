import { webhooksCreate } from "./create.ts";
import { webhooksDelete } from "./delete.ts";
import { webhooksEventTypes } from "./event-types.ts";
import { webhooksGet } from "./get.ts";
import { webhooksList } from "./list.ts";
import { webhooksListen } from "./listen.ts";
import { webhooksMessages } from "./messages.ts";
import { webhooksOpen } from "./open.ts";
import { webhooksReplay } from "./replay.ts";
import { webhooksSecret } from "./secret.ts";
import { webhooksTrigger } from "./trigger.ts";
import { webhooksUpdate } from "./update.ts";
import { webhooksVerify } from "./verify.ts";

export const webhooks = {
  list: webhooksList,
  get: webhooksGet,
  eventTypes: webhooksEventTypes,
  secret: webhooksSecret,
  delete: webhooksDelete,
  update: webhooksUpdate,
  create: webhooksCreate,
  messages: webhooksMessages,
  replay: webhooksReplay,
  trigger: webhooksTrigger,
  open: webhooksOpen,
  verify: webhooksVerify,
  listen: webhooksListen,
};
