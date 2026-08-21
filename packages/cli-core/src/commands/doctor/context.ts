import { getToken, getValidToken } from "../../lib/credential-store.ts";
import { resolveProfile } from "../../lib/config.ts";
import { fetchApplication, type Application } from "../../lib/plapi.ts";
import { resolveKeylessTarget, type KeylessTarget } from "../../lib/keyless-target.ts";
import { peekKeylessBreadcrumb } from "../../lib/keyless.ts";
import { bapiRequest } from "../../lib/bapi.ts";
import { log } from "../../lib/log.ts";
import { CliError, ERROR_CODE, errorMessage } from "../../lib/errors.ts";
import type { DoctorContext, KeylessInstanceInfo, ResolvedProfile } from "./types.ts";

// Every getter below hands back a memoized promise *by identity*, so that N
// checks calling `ctx.getToken()` share one credential read. Marking them
// `async` would wrap the cached promise in a fresh one per call — the cache
// would still work, but `getToken() === getToken()` would stop holding, which
// is the property `context.test.ts` pins.
// oxlint-disable typescript/promise-function-async

export function createDoctorContext(): DoctorContext {
  let tokenPromise: Promise<string | null> | undefined;
  let validTokenPromise: Promise<string | null> | undefined;
  let profilePromise: Promise<ResolvedProfile | undefined> | undefined;
  let appPromise: Promise<Application | null> | undefined;
  let keylessPromise: Promise<KeylessTarget | undefined> | undefined;
  let keylessInstancePromise: Promise<KeylessInstanceInfo | null> | undefined;
  let claimBreadcrumbPromise: Promise<boolean> | undefined;
  let keylessKeyError: CliError | undefined;

  const ctx: DoctorContext = {
    getToken() {
      if (!tokenPromise) {
        tokenPromise = getToken();
      }
      return tokenPromise;
    },

    getValidToken() {
      if (!validTokenPromise) {
        validTokenPromise = getValidToken();
      }
      return validTokenPromise;
    },

    getProfile() {
      if (!profilePromise) {
        profilePromise = resolveProfile(process.cwd());
      }
      return profilePromise;
    },

    getApplication() {
      if (!appPromise) {
        appPromise = (async () => {
          const token = await ctx.getToken();
          if (!token) return null;
          const resolved = await ctx.getProfile();
          if (!resolved) return null;
          return fetchApplication(resolved.profile.appId);
        })();
      }
      return appPromise;
    },

    getKeylessTarget() {
      if (!keylessPromise) {
        // Same resolution every other command uses: an explicit --app/link rules
        // keyless out, but account credentials alone don't (see keyless-target.ts).
        //
        // A malformed local key (not `sk_`-prefixed) is caught here rather than
        // propagated: every keyless-aware check calls this getter, so letting it
        // throw turns one misconfiguration into a "Check crashed" line per check,
        // each stripped of its check name. It's cached as a diagnosable state
        // instead, and checkLoggedIn reports it once, by name, with a remedy.
        keylessPromise = resolveKeylessTarget({ cwd: process.cwd() }).catch((error) => {
          if (error instanceof CliError && error.code === ERROR_CODE.INVALID_KEY_FORMAT) {
            keylessKeyError = error;
            return undefined;
          }
          throw error;
        });
      }
      return keylessPromise;
    },

    async getKeylessKeyError() {
      await ctx.getKeylessTarget();
      return keylessKeyError;
    },

    getKeylessInstance() {
      if (!keylessInstancePromise) {
        keylessInstancePromise = (async () => {
          const keyless = await ctx.getKeylessTarget();
          if (!keyless) return null;

          try {
            const response = await bapiRequest({
              method: "GET",
              path: "/v1/instance",
              secretKey: keyless.secretKey,
            });
            const body = response.body as { id?: string; environment_type?: string };
            return { id: body.id ?? null, environmentType: body.environment_type ?? null };
          } catch (error) {
            // Naming the instance is a nice-to-have here — the checks that
            // actually need the target already have it via getKeylessTarget().
            log.debug(`doctor: could not fetch keyless instance info (${errorMessage(error)})`);
            return null;
          }
        })();
      }
      return keylessInstancePromise;
    },

    hasClaimBreadcrumb() {
      if (!claimBreadcrumbPromise) {
        // peek, not read: readKeylessBreadcrumb clears a malformed file as a
        // side effect, and doctor must leave the project exactly as found.
        claimBreadcrumbPromise = peekKeylessBreadcrumb(process.cwd()).then(Boolean);
      }
      return claimBreadcrumbPromise;
    },

    fixes: {
      login: () => ({
        label: "Log in with clerk auth login",
        run: async () => {
          const { login } = await import("../auth/login.ts");
          await login();
        },
      }),
      link: () => ({
        label: "Link project with clerk link",
        run: async () => {
          const { link } = await import("../link/index.ts");
          await link();
        },
      }),
      envPull: () => ({
        label: "Pull env vars with clerk env pull",
        run: async () => {
          const { pull } = await import("../env/pull.ts");
          await pull({});
        },
      }),
    },
  };

  return ctx;
}
