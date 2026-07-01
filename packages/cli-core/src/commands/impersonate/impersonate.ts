import { CliError } from "../../lib/errors.ts";

export type ImpersonateOptions = {
  user?: string;
  secretKey?: string;
  app?: string;
  instance?: string;
  actor?: string;
  expiresIn?: number;
  open?: boolean;
  print?: boolean;
  yes?: boolean;
};

// Task 4 replaces this function body with the full create flow: login gate,
// targeting, user resolution, confirm, POST /actor_tokens, and output modes.
export async function impersonate(_options: ImpersonateOptions = {}): Promise<void> {
  throw new CliError("`clerk impersonate` is not implemented yet.");
}
