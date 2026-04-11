// packages/cli-core/src/lib/root.ts
/**
 * Production root construction.
 *
 * Wires lib collaborators via their factories in topological order:
 *   env → credentialStore → plapi → config → tokenExchange
 */

import { createEnvironment } from "./environment.ts";
import { createCredentialStore } from "./credential-store.ts";
import { createPlapi } from "./plapi.ts";
import { createConfig } from "./config.ts";
import { createTokenExchange } from "./token-exchange.ts";
import { git } from "./git.ts";
import { bapi } from "../commands/api/bapi.ts";
import { authServer } from "./auth-server.ts";
import { pkce } from "./pkce.ts";
import { prompts } from "./prompts.ts";
import { modeService } from "../mode.ts";
import { createBrowser } from "./browser.ts";
import { createOpener } from "./open.ts";
import { createSystem } from "./system.ts";
import { createRunners } from "./runners.ts";
import { spinner } from "./spinner.ts";
import { logger } from "./logger.ts";
import { env } from "./env.ts";
import { projectDetector } from "./project-detector/index.ts";
import type { Root } from "./deps.ts";

export function createRoot(): Root {
  const system = createSystem();
  const environment = createEnvironment();
  const credentialStore = createCredentialStore(environment);
  const plapi = createPlapi(environment, credentialStore);
  const configStore = createConfig(environment, plapi, git);
  const tokenExchange = createTokenExchange(environment);

  return {
    credentialStore,
    configStore,
    git,
    plapi,
    bapi,
    tokenExchange,
    authServer,
    pkce,
    prompts,
    mode: modeService,
    browser: createBrowser(system),
    opener: createOpener(system),
    system,
    runners: createRunners(system),
    spinner,
    log: logger,
    env,
    environment,
    projectDetector,
  };
}
