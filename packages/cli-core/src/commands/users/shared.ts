import { CliError } from "../../lib/errors.ts";

export {
  buildCreateUserPayload,
  buildUpdateUserPayload,
  mergeUsersPayload,
} from "../../lib/users.ts";

export function createUsersStub(commandName: string) {
  return async () => {
    throw new CliError(`clerk users ${commandName} is not implemented yet.`);
  };
}
