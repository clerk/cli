import { getToken } from "../../lib/credential-store.ts";
import { resolveProfile } from "../../lib/config.ts";
import { fetchApplication, type Application } from "../../lib/plapi.ts";
import type { DoctorContext, ResolvedProfile } from "./types.ts";

export function createDoctorContext(): DoctorContext {
  let tokenPromise: Promise<string | null> | undefined;
  let profilePromise: Promise<ResolvedProfile | undefined> | undefined;
  let appPromise: Promise<Application | null> | undefined;

  const ctx: DoctorContext = {
    getToken() {
      if (!tokenPromise) {
        tokenPromise = getToken();
      }
      return tokenPromise;
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
  };

  return ctx;
}
