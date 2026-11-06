/**
 * The Clerk instances the live tests run against (targets.json):
 *   pool     test:custom claims a free one, uses it, empties it; Clerk-as-source imports into pool-1
 *   source   the migration eval's Clerk source in migration-test-apps; listed here only so
 *            a pool target can't be the same instance
 *   migrate  test:migrate's own instance
 *
 * Secret keys and app IDs come from the environment (1Password locally, the migrate-live environment in CI), named by
 * `keyEnv` and `appEnv` (or `app` gives the ID itself); the instance ID is
 * looked up from the key (BAPI GET /v1/instance) unless the file gives it.
 * Locks are per instance ID, so an instance listed twice (a pool target that is also
 * test:migrate's instance) is still only used by one run at a time.
 */
import { readFileSync } from "node:fs";
import { instanceIdOf, SetupError } from "./clerk-run";
import { claimAny, clerkLock, type ScheduleOptions } from "./lock";

export type TargetSpec = {
  name: string;
  keyEnv: string;
  appEnv?: string;
  app?: string;
  instance?: string;
};
export type ClerkTarget = {
  name: string;
  app: string;
  instance: string;
  secretKey: string;
  keyEnv: string;
};
type TargetsFile = { pool: TargetSpec[]; source: TargetSpec; migrate: TargetSpec };

const FILE = "targets.json";
export const targetSpecs = (): TargetsFile => JSON.parse(readFileSync(FILE, "utf8"));

const resolved = new Map<string, Promise<ClerkTarget>>();

/** The target behind `spec`, with its key and instance ID. Throws SetupError when it can't be used. */
export function resolveTarget(spec: TargetSpec): Promise<ClerkTarget> {
  const cached = resolved.get(spec.name);
  if (cached) return cached;
  const p = (async () => {
    const secretKey = process.env[spec.keyEnv];
    if (!secretKey)
      throw new SetupError(
        `${spec.keyEnv} is not set (Clerk target "${spec.name}"): run through bun run test:migrate-live*, or export it`,
      );
    const app = spec.app ?? (spec.appEnv ? process.env[spec.appEnv] : undefined);
    if (!app || !/^app_[A-Za-z0-9]+$/.test(app)) {
      throw new SetupError(
        `Clerk target "${spec.name}": no app ID (${spec.appEnv ? `${spec.appEnv} is ${app ? `"${app}"` : "not set"}` : `"app" missing in ${FILE}`})`,
      );
    }
    let instance = spec.instance;
    if (!instance) {
      instance = await instanceIdOf(secretKey).catch((e: Error) => {
        throw new SetupError(`${spec.keyEnv}: ${e.message}`);
      });
    }
    return { name: spec.name, app, instance, secretKey, keyEnv: spec.keyEnv };
  })();
  resolved.set(spec.name, p);
  return p;
}

export const poolTargets = () => Promise.all(targetSpecs().pool.map(resolveTarget));

/**
 * Every role must be its own instance: a pool target that is also the source
 * or test:migrate's instance would be emptied under them. Entries that can't
 * be resolved yet are left out.
 *
 * @returns Each instance listed more than once, with the names that share it.
 */
export async function sharedInstances(): Promise<{ instance: string; names: string[] }[]> {
  const specs = targetSpecs();
  const all = await Promise.all(
    [...specs.pool, specs.source, specs.migrate].map((s) =>
      resolveTarget(s).catch(() => undefined),
    ),
  );
  const byInstance = new Map<string, string[]>();
  for (const t of all)
    if (t) byInstance.set(t.instance, [...(byInstance.get(t.instance) ?? []), t.name]);
  return [...byInstance]
    .filter(([, names]) => names.length > 1)
    .map(([instance, names]) => ({ instance, names }));
}
export const sourceTarget = () => resolveTarget(targetSpecs().source);
export const migrateTarget = () => resolveTarget(targetSpecs().migrate);

/** `--app` and `--instance` for CLI commands aimed at `t`. */
export const targetArgs = (t: ClerkTarget) => ["--app", t.app, "--instance", t.instance];

/** What a child process needs to use the target its parent claimed (the lock comes through PROVIDER_LOCKS). */
export const targetEnv = (t: ClerkTarget) => ({ CLERK_TARGET_NAME: t.name });

/**
 * A free pool target for one run: the first unlocked one, else wait 5 min and
 * look again, failing after an hour. A child of a run that already claimed one
 * (CLERK_TARGET_NAME) gets that one.
 *
 * @throws SetupError when no target comes free, or a target can't be used.
 */
export async function claimTarget(
  what: string,
  opts: ScheduleOptions = {},
): Promise<{ target: ClerkTarget; release: () => void }> {
  const specs = targetSpecs();
  const pinned = process.env.CLERK_TARGET_NAME;
  if (pinned) {
    const spec = [...specs.pool, specs.source, specs.migrate].find((s) => s.name === pinned);
    if (!spec) throw new SetupError(`CLERK_TARGET_NAME="${pinned}" is not in ${FILE}`);
    return { target: await resolveTarget(spec), release: () => {} };
  }
  const shared = await sharedInstances();
  if (shared.length) {
    throw new SetupError(
      `targets.json: one Clerk instance in two roles (${shared.map((s) => `${s.names.join(" + ")}: ${s.instance}`).join("; ")})`,
    );
  }
  const pool = await poolTargets();
  try {
    const { taken, release } = await claimAny(pool, (t) => [clerkLock(t.instance)], what, {
      log: (l) => console.log(`Clerk targets: ${l}`),
      ...opts,
    });
    return { target: taken, release };
  } catch (e) {
    throw new SetupError(`No Clerk target free: ${(e as Error).message}`);
  }
}
