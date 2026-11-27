import { existsSync, readFileSync } from "node:fs";
import { flag } from "./args";

export type SeedUser = {
  id: string;
  group: "email-only" | "phone-only" | "both";
  email: string | null;
  phone: string | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  hasPassword: boolean;
  emailVerified: boolean;
  phoneVerified: boolean;
  // Optional edge-case fields. The generator never sets these; test variations
  // add them, and each seeder writes the ones its provider can store.
  /** Blocked / banned / disabled at the source. */
  banned?: boolean;
  /**
   * user → the provider's user-editable metadata, app → its server-only
   * metadata, public → readable-but-not-editable (Clerk's public metadata).
   */
  metadata?: {
    user?: Record<string, unknown>;
    app?: Record<string, unknown>;
    public?: Record<string, unknown>;
  };
  /** A source-side ID to create the user with, where the provider allows one. */
  sourceId?: string;
  /** How the source stores the password. Default: the provider's native hash. */
  passwordFormat?:
    | "bcrypt"
    | "argon2id"
    | "unknown"
    | "hmac_sha256"
    | "md5"
    | "pbkdf2_sha256"
    | "standard_scrypt";
  /** OAuth providers linked to the account, e.g. ["github"]. */
  oauth?: string[];
  /** Enrolled in TOTP 2FA at the source. */
  mfa?: boolean;
  /** An anonymous / guest account. */
  anonymous?: boolean;
  /** Organization memberships, where the source has organizations. */
  orgs?: { name: string; role?: string }[];
  /** Soft-deleted at the source (still a row, flagged deleted). */
  deleted?: boolean;
  /** Created through enterprise SSO (SAML/OIDC) at the source. */
  sso?: boolean;
};

/**
 * Which seed file to read. Every seeder and the reset script share this, so
 * `bun seed.ts -p clerk --10k` and `bun seed.ts -p auth0 --10k` mean the same thing.
 * SEED_USERS_FILE wins, for a file neither flag names.
 */
export function usersFile(): string {
  if (process.env.SEED_USERS_FILE) return process.env.SEED_USERS_FILE;
  return flag("tenK") ? "data/users-10k.json" : "data/users.json";
}

export function loadUsers(): { seedPassword: string; users: SeedUser[] } {
  const file = usersFile();
  if (!existsSync(file))
    throw new Error(
      `${file} not found — regenerate it with generate-users.ts in migration-test-apps`,
    );
  console.log(`Reading ${file}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Providers that require an email give phone-only users this placeholder. */
export const placeholderEmail = (phone: string) => `${phone.replace(/\D/g, "")}@phone.local`;

export const displayName = (u: SeedUser) =>
  u.fullName ?? u.username ?? u.email?.split("@")[0] ?? u.phone ?? "User";

/**
 * Runs `work` over `items` with a fixed number of workers, retrying anything
 * that looks like rate limiting. Every hosted provider here throttles user
 * creation, and 500 sequential round trips is needlessly slow.
 */
export async function pool<T>(
  items: T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<void>,
  onProgress?: (done: number, total: number, failed: number) => void,
) {
  let cursor = 0;
  let done = 0;
  const failures: { item: T; error: unknown }[] = [];

  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        await withRetry(() => work(items[index], index));
      } catch (error) {
        failures.push({ item: items[index], error });
      }
      onProgress?.(++done, items.length, failures.length);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return failures;
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = extractStatus(error);
      if (attempt >= attempts || (status !== 429 && status !== 503)) throw error;
      // Exponential backoff: 1s, 2s, 4s, 8s.
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
}

function extractStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as { status?: number; statusCode?: number; code?: unknown };
  if (typeof e.status === "number") return e.status;
  if (typeof e.statusCode === "number") return e.statusCode;
  return undefined;
}

export function progressBar(label: string) {
  return (done: number, total: number, failed: number) => {
    const suffix = failed ? `  (${failed} failed)` : "";
    process.stdout.write(`\r  ${label}: ${done}/${total}${suffix}   `);
    if (done === total) process.stdout.write("\n");
  };
}

/**
 * Sets a non-zero exit code, which `bun seed.ts` reads back to decide whether a
 * seeder actually did its job. A run where every user is a duplicate finishes
 * without throwing, so this is the only signal that nothing was created.
 */
export function reportFailures(failures: { item: unknown; error: unknown }[]) {
  if (!failures.length) return;
  console.error(`\n${failures.length} user(s) failed. First few:`);
  for (const { item, error } of failures.slice(0, 5)) {
    const id = (item as SeedUser).id ?? "?";
    console.error(`  ${id}: ${describe(error).slice(0, 200)}`);
  }
  process.exitCode = 1;
}

/**
 * Some SDKs put the useful part somewhere other than `message` — WorkOS throws
 * "Could not create user." with the real reason in `code`, which is the
 * difference between a duplicate and a malformed record.
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return JSON.stringify(error);
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && !error.message.includes(code)
    ? `${error.message} (${code})`
    : error.message;
}
