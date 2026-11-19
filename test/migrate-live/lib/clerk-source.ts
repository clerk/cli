/**
 * Clerk as a migration *source*: seeding a Clerk instance, emptying it, and
 * changing its config through the CLI. Shared by seed-clerk.ts and
 * variations/clerk.ts.
 */
import { createClerkClient } from "@clerk/backend";
import { cliArgv, DEFAULT_CLI } from "./clerk-run";
import { run } from "./run";
import { TARGETS } from "./clerk-run";
import { pool, withRetry, type SeedUser } from "./users";

/**
 * The Clerk instance used as a migration source. For test:migrate it is the
 * migrate instance, which is also the destination (Stage 7). eval:migrations
 * points it at its own source instance through CLERK_AS_SOURCE_{SECRET_KEY,APP,INSTANCE}.
 */
export const SOURCE = {
  // Read when used, not on import: TARGETS.dev's instance ID is only known after resolveTargets().
  get app() {
    return process.env.CLERK_AS_SOURCE_APP ?? TARGETS.dev.app;
  },
  get instance() {
    return process.env.CLERK_AS_SOURCE_INSTANCE ?? TARGETS.dev.instance;
  },
};
/** Set only when the source is a separate instance from test:migrate's destination. */
export const SOURCE_SECRET_KEY = process.env.CLERK_AS_SOURCE_SECRET_KEY;

/** The CLI under test: test-migrate.ts sets MIGRATE_TEST_CLI from --cli. */
const CLI = () => process.env.MIGRATE_TEST_CLI ?? DEFAULT_CLI;

export const clerkClient = () =>
  createClerkClient({ secretKey: SOURCE_SECRET_KEY ?? process.env[TARGETS.dev.key]! });

/** A fixed TOTP secret and backup codes, so an MFA user is reproducible. */
export const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
export const BACKUP_CODES = ["mt-backup-0001", "mt-backup-0002", "mt-backup-0003"];

/** ada.lovelace4@example.com -> ada.lovelace4+clerk_test@example.com */
export function testEmail(email: string) {
  const [local, domain] = email.split("@");
  return `${local}+clerk_test@${domain}`;
}

/** Clerk usernames must be 4-64 chars of letters, digits, _ or -. */
export function clerkUsername(username: string | null) {
  if (!username) return undefined;
  const cleaned = username.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.length >= 4 ? cleaned.slice(0, 64) : undefined;
}

export async function createSeedUser(u: SeedUser, seedPassword: string) {
  const clerk = clerkClient();
  const user = await clerk.users.createUser({
    externalId: u.id,
    emailAddress: u.email ? [testEmail(u.email)] : undefined,
    phoneNumber: u.phone ? [u.phone] : undefined,
    username: clerkUsername(u.username),
    firstName: u.firstName ?? undefined,
    lastName: u.lastName ?? undefined,
    password: u.hasPassword ? seedPassword : undefined,
    // The seed password is strong, but every user shares it — skip the
    // breach check rather than have 425 identical passwords rejected.
    skipPasswordChecks: u.hasPassword ? true : undefined,
    skipPasswordRequirement: u.hasPassword ? undefined : true,
    // Needs authenticator_app + backup_code on (variations/clerk.ts C5).
    ...(u.mfa && { totpSecret: TOTP_SECRET, backupCodes: BACKUP_CODES }),
    publicMetadata: u.metadata?.public,
    privateMetadata: u.metadata?.app,
    unsafeMetadata: u.metadata?.user,
  });
  // Retried on its own: a 429 here must not make the caller's retry re-create
  // a user that already exists.
  if (u.banned) await withRetry(() => clerk.users.banUser(user.id), 8);
  return user;
}

/**
 * Deletes every user in an instance: the source instance by default, or the
 * test instance `clerk` is a client for. Only ever pointed at test instances.
 */
export async function deleteAllUsers(clerk = clerkClient()) {
  for (;;) {
    const { data } = await withRetry(() => clerk.users.getUserList({ limit: 100 }), 8);
    if (!data.length) return;
    // The user list lags behind deletes, so a second pass can list users the first already
    // deleted; their 404 means done.
    const failures = await pool(data, 4, async (u) => {
      await clerk.users.deleteUser(u.id).catch((e) => {
        if (e?.status !== 404) throw e;
      });
    });
    if (failures.length)
      throw new Error(
        `${failures.length} users could not be deleted: ${String(failures[0].error)}`,
      );
  }
}

const cli = (args: string[]) => {
  const [bin, ...pre] = cliArgv(CLI());
  return run(bin, [...pre, "config", ...args, "--app", SOURCE.app, "--instance", SOURCE.instance], {
    ...process.env,
    CLERK_TELEMETRY_DISABLED: "1",
  });
};

export async function configPull(): Promise<Record<string, unknown>> {
  const { code, stdout, stderr } = await cli(["pull"]);
  if (code !== 0) throw new Error(`clerk config pull exited ${code}: ${stderr.slice(-300)}`);
  return JSON.parse(stdout);
}

export async function configPatch(body: object) {
  const { code, stderr } = await cli(["patch", "--json", JSON.stringify(body), "--yes"]);
  if (code !== 0) throw new Error(`clerk config patch exited ${code}: ${stderr.slice(-300)}`);
}
