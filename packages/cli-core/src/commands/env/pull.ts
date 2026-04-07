import type { PullDefaultDeps, PullDefaultOptions } from "./helpers/pull-default.ts";
import { pullDefault } from "./helpers/pull-default.ts";

export type EnvPullDeps = PullDefaultDeps;

interface EnvPullOptions extends PullDefaultOptions {}

export async function pull(deps: EnvPullDeps, options: EnvPullOptions = {}): Promise<void> {
  return pullDefault(deps, options);
}
