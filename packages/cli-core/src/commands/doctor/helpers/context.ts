/**
 * Lazy, memoized run-state for the doctor command. Each `clerk doctor` run
 * builds one of these so multiple checks can share the same token / profile /
 * application lookups instead of re-doing the I/O.
 *
 * The `context.ts` module previously lived alongside `index.ts` and read from
 * raw `lib/credential-store.ts`, `lib/config.ts`, and `lib/plapi.ts` imports.
 * It is now folded into the doctor helpers directory and reads everything via
 * its narrow injected slice.
 */

import type { Need } from "../../../lib/deps.ts";
import type { Application } from "../../../lib/plapi.ts";
import type { DoctorContext, ResolvedProfile } from "../types.ts";

export type CreateDoctorContextDeps = Need<{
  credentialStore: "getToken";
  configStore: "resolveProfile";
  plapi: "fetchApplication";
}>;

export function createDoctorContext(deps: CreateDoctorContextDeps): DoctorContext {
  let tokenPromise: Promise<string | null> | undefined;
  let profilePromise: Promise<ResolvedProfile | undefined> | undefined;
  let appPromise: Promise<Application | null> | undefined;

  const ctx: DoctorContext = {
    getToken() {
      if (!tokenPromise) {
        tokenPromise = deps.credentialStore.getToken();
      }
      return tokenPromise;
    },

    getProfile() {
      if (!profilePromise) {
        profilePromise = deps.configStore.resolveProfile(process.cwd());
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
          return deps.plapi.fetchApplication(resolved.profile.appId);
        })();
      }
      return appPromise;
    },
  };

  return ctx;
}
