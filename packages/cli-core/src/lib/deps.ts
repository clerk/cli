// packages/cli-core/src/lib/deps.ts
import type { CredentialStore } from "./credential-store.ts";
import type { ConfigStore } from "./config.ts";
import type { Git } from "./git.ts";
import type { Plapi } from "./plapi.ts";
import type { Bapi } from "../commands/api/bapi.ts";
import type { TokenExchange } from "./token-exchange.ts";
import type { AuthServer } from "./auth-server.ts";
import type { Pkce } from "./pkce.ts";
import type { Prompts } from "./prompts.ts";
import type { ModeService } from "../mode.ts";
import type { Browser } from "./browser.ts";
import type { System } from "./system.ts";
import type { Spinner } from "./spinner.ts";
import type { Logger } from "./logger.ts";
import type { Env } from "./env.ts";
import type { Environment } from "./environment.ts";
import type { ProjectDetector } from "./project-detector/index.ts";

/**
 * Single source of truth for every injectable collaborator.
 * Add a line here when introducing a new I/O-bound module.
 */
export interface DepsRegistry {
  credentialStore: CredentialStore;
  configStore: ConfigStore;
  git: Git;
  plapi: Plapi;
  bapi: Bapi;
  tokenExchange: TokenExchange;
  authServer: AuthServer;
  pkce: Pkce;
  prompts: Prompts;
  mode: ModeService;
  browser: Browser;
  system: System;
  spinner: Spinner;
  log: Logger;
  env: Env;
  environment: Environment;
  projectDetector: ProjectDetector;
}

/** The full root passed to every command. Identical to the registry. */
export type Root = DepsRegistry;

/**
 * Declare a function's exact dependency slice.
 *
 * Keys are constrained via a self-referencing constraint: every key in `Spec`
 * is checked against `keyof DepsRegistry`. A typo'd key gets a `never` value
 * type in the constraint, which fails to compile because no value satisfies
 * `never`. The error names the typo'd key explicitly.
 *
 * Each value is either a union of method names from that collaborator
 * (yields `Pick<...>`) or the literal `"*"` (yields the full collaborator).
 * Method-name typos fail at the declaration site with a "did you mean..."
 * autocomplete on the valid options.
 */
export type Need<
  Spec extends {
    [K in keyof Spec]: K extends keyof DepsRegistry ? keyof DepsRegistry[K] | "*" : never;
  },
> = {
  [K in keyof Spec & keyof DepsRegistry]-?: Spec[K] extends "*"
    ? DepsRegistry[K]
    : Spec[K] extends keyof DepsRegistry[K]
      ? Pick<DepsRegistry[K], Spec[K]>
      : never;
};
