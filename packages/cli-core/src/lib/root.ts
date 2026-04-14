// packages/cli-core/src/lib/root.ts
/**
 * Production root construction.
 *
 * Builds the full Root object literal that gets passed to every command
 * via createProgram(root). Construction is O(1): every value is a
 * pre-built namespace object literal from its respective lib module.
 */

import { credentialStore } from "./credential-store.ts";
import { configStore } from "./config.ts";
import { git } from "./git.ts";
import { plapi } from "./plapi.ts";
import { bapi } from "../commands/api/bapi.ts";
import { tokenExchange } from "./token-exchange.ts";
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
import { environment } from "./environment.ts";
import { projectDetector } from "./project-detector/index.ts";
import type { Root } from "./deps.ts";

export function createRoot(): Root {
  const system = createSystem();
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
