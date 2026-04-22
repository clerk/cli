import { getToken, getValidToken } from "../../lib/credential-store.ts";
import { resolveProfile } from "../../lib/config.ts";
import { fetchApplication, type Application } from "../../lib/plapi.ts";
import type { DoctorContext, ResolvedProfile } from "./types.ts";

export function createDoctorContext(): DoctorContext {
  let tokenPromise: Promise<string | null> | undefined;
  let validTokenPromise: Promise<string | null> | undefined;
  let profilePromise: Promise<ResolvedProfile | undefined> | undefined;
  let appPromise: Promise<Application | null> | undefined;

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
