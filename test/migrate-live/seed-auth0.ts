/**
 * Seeds an Auth0 tenant from data/users.json using the bulk import job:
 * POST /api/v2/jobs/users-imports. One job handles hundreds of users in a
 * single request, which beats 500 throttled POST /api/v2/users calls.
 *
 * Uses the same application as the web app. A Regular Web App can be granted
 * client_credentials against the Management API, so one client id/secret covers
 * both login and seeding — fine for a test tenant of fake users. Split it back
 * out into a dedicated M2M app before pointing this at anything real.
 *
 * Auth0 database connections require an email, so phone-only users get the same
 * <digits>@phone.local placeholder the other apps use. Username and phone go on
 * the real `username` / `phone_number` fields when the connection is configured
 * to store them (see connectionSupports), and into user_metadata otherwise.
 *
 * Run: bun seed.ts -p auth0
 */
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { loadUsers, placeholderEmail, type SeedUser } from "./lib/users";
import { api } from "./lib/auth0";

const CONNECTION_NAME = process.env.AUTH0_DB_CONNECTION || "Username-Password-Authentication";
/** Auth0 rejects an import file larger than 500KB. */
const MAX_FILE_BYTES = 450_000;

const { seedPassword, users } = loadUsers();

/**
 * Every user shares one password, so one bcrypt hash is computed and reused.
 * Per-user salting would cost 425 rounds of bcrypt to protect a password that
 * is written in the README.
 */
function importRecord(u: SeedUser, passwordHash: string, supports: Supports) {
  const email = u.email ?? placeholderEmail(u.phone!);
  // Real fields when the connection can hold them, metadata when it cannot —
  // Auth0 rejects `username` unless the connection requires one.
  const nativeUsername = supports.username && u.username;
  const nativePhone = supports.phone && u.phone;
  return {
    email,
    email_verified: u.emailVerified,
    ...(u.hasPassword ? { password_hash: passwordHash } : {}),
    ...(nativeUsername ? { username: u.username } : {}),
    ...(u.username ? { nickname: u.username } : {}),
    ...(nativePhone ? { phone_number: u.phone, phone_verified: u.phoneVerified } : {}),
    ...(u.firstName ? { given_name: u.firstName } : {}),
    ...(u.lastName ? { family_name: u.lastName } : {}),
    ...(u.fullName ? { name: u.fullName } : {}),
    ...(u.banned ? { blocked: true } : {}),
    // Auth0 prefixes this with the strategy: "auth0|<sourceId>".
    ...(u.sourceId ? { user_id: u.sourceId } : {}),
    ...(u.metadata?.app ? { app_metadata: u.metadata.app } : {}),
    user_metadata: {
      seed_id: u.id,
      ...(u.phone && !nativePhone ? { phone: u.phone } : {}),
      ...(u.username && !nativeUsername ? { username: u.username } : {}),
      ...u.metadata?.user,
    },
  };
}

type Supports = { username: boolean; phone: boolean };

/**
 * What the connection can store natively: a username only when
 * `requires_username` is on (or Flexible Identifiers has a username attribute),
 * a phone only when Flexible Identifiers has the phone_number attribute.
 */
function connectionSupports(options: {
  requires_username?: boolean;
  attributes?: { phone_number?: unknown; username?: unknown };
}): Supports {
  return {
    username: !!options.requires_username || !!options.attributes?.username,
    phone: !!options.attributes?.phone_number,
  };
}

/** Splits records into files that stay under Auth0's 500KB limit. */
function chunk(records: object[]) {
  const chunks: object[][] = [];
  let current: object[] = [];

  for (const record of records) {
    const next = [...current, record];
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_FILE_BYTES && current.length) {
      chunks.push(current);
      current = [record];
    } else {
      current = next;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function waitForJob(jobId: string, label: string) {
  for (;;) {
    const job = (await api(`/jobs/${jobId}`)) as {
      status: string;
      percentage_done?: number;
      time_left_seconds?: number;
      summary?: Record<string, number>;
    };
    if (job.status === "completed" || job.status === "failed") {
      process.stdout.write("\n");
      return job;
    }
    // A 2000-user import runs for several minutes; without this the script
    // looks hung.
    process.stdout.write(
      `\r  ${label}: ${job.status} ${job.percentage_done ?? 0}%` +
        (job.time_left_seconds ? ` (~${job.time_left_seconds}s left)` : "") +
        "   ",
    );
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const connections = (await api(
  `/connections?name=${encodeURIComponent(CONNECTION_NAME)}&strategy=auth0`,
)) as { id: string; name: string; options?: Parameters<typeof connectionSupports>[0] }[];
assert.ok(
  connections.length,
  `No database connection named "${CONNECTION_NAME}". Set AUTH0_DB_CONNECTION.`,
);
const connectionId = connections[0].id;
// Auth0 only returns `options` with the read:connections_options scope. Without
// it every connection looks like a plain one, and usernames and phones would
// quietly land in metadata — refuse instead of seeding the wrong shape.
assert.ok(
  connections[0].options,
  `Cannot read the options of "${CONNECTION_NAME}": grant read:connections_options ` +
    "(APIs → Auth0 Management API → Application Access → Edit).",
);
const supports = connectionSupports(connections[0].options);
console.log(
  `Connection stores username: ${supports.username ? "natively" : "in user_metadata"}, ` +
    `phone: ${supports.phone ? "natively" : "in user_metadata"}`,
);

// $2b$ with 10 rounds is what Auth0 expects for a plain password_hash.
const passwordHash = await bcrypt.hash(seedPassword, 10);
assert.ok(await bcrypt.compare(seedPassword, passwordHash), "bcrypt hash does not verify");

const chunks = chunk(users.map((u) => importRecord(u, passwordHash, supports)));
console.log(
  `Importing ${users.length} users into "${CONNECTION_NAME}" in ${chunks.length} job(s)…`,
);

for (const [index, records] of chunks.entries()) {
  const form = new FormData();
  form.set("connection_id", connectionId);
  form.set("upsert", "true");
  form.set("send_completion_email", "false");
  form.set(
    "users",
    new Blob([JSON.stringify(records)], { type: "application/json" }),
    "users.json",
  );

  const job = (await api("/jobs/users-imports", {
    method: "POST",
    body: form,
  })) as { id: string };

  const label = `job ${index + 1}/${chunks.length} (${records.length} users)`;
  const result = await waitForJob(job.id, label);
  console.log(`  ${label}: ${result.status}`);
  if (result.summary) console.table(result.summary);
  if (result.status === "failed") process.exitCode = 1;
}

console.log(`\nSeed password: ${seedPassword}`);
console.log("Phone-only users were imported as <digits>@phone.local.");
