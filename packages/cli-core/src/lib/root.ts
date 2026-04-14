// packages/cli-core/src/lib/root.ts
/**
 * Production root construction.
 *
 * Wires lib collaborators via their factories. Factories with deps
 * (environment, credentialStore, plapi, configStore, tokenExchange, spinner,
 * system-backed collaborators like browser/opener/runners) are built in
 * topological order after their dependencies.
 */

import { createEnvironment } from "./environment.ts";
import { createCredentialStore } from "./credential-store.ts";
import { createPlapi } from "./plapi.ts";
import { createConfig } from "./config.ts";
import { createTokenExchange } from "./token-exchange.ts";
import { createGit } from "./git.ts";
import { createBapi } from "./bapi.ts";
import { createAuthServer } from "./auth-server.ts";
import { createPkce } from "./pkce.ts";
import { createPrompts } from "./prompts.ts";
import { createModeService } from "./mode.ts";
import { createBrowser } from "./browser.ts";
import { createOpener } from "./open.ts";
import { createSystem } from "./system.ts";
import { createRunners } from "./runners.ts";
import { createSpinner } from "./spinner.ts";
import { createLogger } from "./logger.ts";
import { createEnv } from "./env.ts";
import { createProjectDetector } from "./project-detector/index.ts";
import type { Root } from "./deps.ts";

export function createRoot(): Root {
  const system = createSystem();
  const environment = createEnvironment();
  const credentialStore = createCredentialStore(environment);
  const plapi = createPlapi(environment, credentialStore);
  const git = createGit();
  const configStore = createConfig(environment, plapi, git);
  const tokenExchange = createTokenExchange(environment);
  const mode = createModeService();

  return {
    credentialStore,
    configStore,
    git,
    plapi,
    bapi: createBapi(),
    tokenExchange,
    authServer: createAuthServer(),
    pkce: createPkce(),
    prompts: createPrompts(),
    mode,
    browser: createBrowser(system),
    opener: createOpener(system),
    system,
    runners: createRunners(system),
    spinner: createSpinner(mode),
    log: createLogger(),
    env: createEnv(),
    environment,
    projectDetector: createProjectDetector(),
  };
}
