/**
 * Deletes every user from a provider, so a 500-user file and a 10,000-user file
 * can be swapped without colliding. Only Auth0's seeder upserts; every other
 * provider reports duplicates on a second seed, so this is the way back.
 *
 *   bun reset.ts                         dry run over every provider except Clerk
 *   bun reset.ts -y                      actually delete from those
 *   bun reset.ts -p workos -y            just that one
 *   bun reset.ts -p clerk -y             empties the migration destination
 *
 * Mirrors `bun seed.ts`: no --provider means everything except Clerk, which is
 * only touched when named.
 *
 * Without --yes it lists what it would delete and stops. This is destructive and
 * there is no undo, so it always prints which tenant/project it is pointed at
 * before touching anything.
 */
import { PROVIDERS, selectProviders, type Provider } from "./lib/providers";
import { lockProviders } from "./lib/lock";
import { pool, progressBar, reportFailures } from "./lib/users";
import { flag, spell } from "./lib/args";

const confirmed = flag("yes");

if (flag("help")) {
  console.log(
    `Usage: bun reset.ts [options]\n\n` +
      `  ${spell("provider").padEnd(18)} one of ${PROVIDERS.join(" ")}\n` +
      `  ${"".padEnd(18)} (default: all of them except clerk)\n` +
      `  ${spell("yes").padEnd(18)} actually delete; without it this only counts\n` +
      `  ${spell("help").padEnd(18)} this message`,
  );
  process.exit(0);
}

/** Collect ids first, delete second — deleting while paging skips records. */
type Plan = {
  where: string;
  ids: string[];
  remove: (ids: string[]) => Promise<void>;
  /** The listing hit a provider ceiling: delete, then list again. */
  capped?: boolean;
};

async function planClerk(): Promise<Plan> {
  const { createClerkClient } = await import("@clerk/backend");
  const clerk = createClerkClient({ secretKey: process.env.CLERK_MIGRATE_TESTS_1_SECRET_KEY! });

  const ids: string[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data } = await clerk.users.getUserList({ limit: 500, offset });
    if (!data.length) break;
    ids.push(...data.map((u) => u.id));
  }
  return {
    where: "the Clerk instance for CLERK_MIGRATE_TESTS_1_SECRET_KEY",
    ids,
    remove: async (batch) => {
      const failures = await pool(
        batch,
        4,
        async (id) => void (await clerk.users.deleteUser(id)),
        progressBar("deleted"),
      );
      reportFailures(failures);
    },
  };
}

async function planAuth0(): Promise<Plan> {
  // The shared helper caches one token and retries every call on 429 — the
  // free tier's ~2 req/s is easy to hit, and a bare listing call that gives up
  // on the first 429 is what stopped a 10K reset partway through.
  const { api, managementToken } = await import("./lib/auth0");
  const token = await managementToken();
  const scope = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).scope ?? "";
  if (!scope.split(" ").includes("delete:users"))
    throw new Error(
      "the app is missing the delete:users scope — APIs -> Auth0 Management API -> " +
        "Application Access -> Edit, tick delete:users",
    );

  /*
   * GET /api/v2/users has page/per_page pagination only (take/from is ignored
   * there and silently returns one 50-user page), and it stops at the 1000th
   * user. So list up to that ceiling and flag the plan as capped: reset()
   * deletes the batch and lists again until the tenant is empty.
   */
  const ids: string[] = [];
  for (let page = 0; page < 10; page++) {
    const users = await api<{ user_id: string }[]>(
      `/users?per_page=100&page=${page}&fields=user_id&include_fields=true`,
    );
    ids.push(...users.map((u) => u.user_id));
    if (users.length < 100) break;
  }

  return {
    where: `the Auth0 tenant ${process.env.AUTH0_DOMAIN}`,
    ids,
    capped: ids.length === 1000,
    remove: async (batch) => {
      const failures = await pool(
        batch,
        2, // the free tier's rate; more only buys 429s
        async (id) => {
          // 204 on success, 404 if it went already — both are fine.
          await api(`/users/${encodeURIComponent(id)}`, { method: "DELETE" }).catch((e) => {
            if (e.status !== 404) throw e;
          });
        },
        progressBar("deleted"),
      );
      reportFailures(failures);
    },
  };
}

async function planSupabase(): Promise<Plan> {
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    if (!data.users.length) break;
    ids.push(...data.users.map((u) => u.id));
  }
  return {
    where: `the Supabase project ${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname}`,
    ids,
    remove: async (batch) => {
      const failures = await pool(
        batch,
        8,
        async (id) => {
          const { error } = await supabase.auth.admin.deleteUser(id);
          if (error) throw error;
        },
        progressBar("deleted"),
      );
      reportFailures(failures);
    },
  };
}

async function planFirebase(): Promise<Plan> {
  const { cert, getApps, initializeApp } = await import("firebase-admin/app");
  const { getAuth } = await import("firebase-admin/auth");
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON!);
  if (!getApps().length) initializeApp({ credential: cert(serviceAccount) });
  const auth = getAuth();

  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    ids.push(...page.users.map((u) => u.uid));
    pageToken = page.pageToken;
  } while (pageToken);

  return {
    where: `the Firebase project ${serviceAccount.project_id}`,
    ids,
    // The Admin SDK deletes up to 1000 at a time, which is the whole job in ten
    // calls rather than 10,000.
    remove: async (batch) => {
      for (let i = 0; i < batch.length; i += 1000) {
        const slice = batch.slice(i, i + 1000);
        const result = await auth.deleteUsers(slice);
        process.stdout.write(`\r  deleted: ${Math.min(i + 1000, batch.length)}/${batch.length}   `);
        if (result.failureCount)
          console.error(`\n  ${result.failureCount} failed: ${result.errors[0]?.error.message}`);
      }
      process.stdout.write("\n");
    },
  };
}

async function planWorkos(): Promise<Plan> {
  const { WorkOS } = await import("@workos-inc/node");
  const workos = new WorkOS(process.env.WORKOS_API_KEY!);

  const ids: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await workos.userManagement.listUsers({ limit: 100, after });
    ids.push(...page.data.map((u) => u.id));
    after = page.listMetadata.after ?? undefined;
    if (!after) break;
  }
  return {
    where: "the WorkOS environment for WORKOS_API_KEY",
    ids,
    remove: async (batch) => {
      const failures = await pool(
        batch,
        4,
        async (id) => {
          await workos.userManagement.deleteUser(id);
        },
        progressBar("deleted"),
      );
      reportFailures(failures);
    },
  };
}

/**
 * The Turso-backed apps are the odd ones out: the users are rows we own, so a
 * DELETE clears a database instantly instead of one API call per user. Each app
 * has its own database, so they reset independently.
 */
const TURSO: Record<
  "authjs" | "better-auth",
  { urlKey: string; tokenKey: string; tables: string[] }
> = {
  "better-auth": {
    urlKey: "BA_TURSO_DATABASE_URL",
    tokenKey: "BA_TURSO_DATABASE_TOKEN",
    tables: ["session", "account", "verification", "user"],
  },
  authjs: {
    urlKey: "AUTHJS_TURSO_DATABASE_URL",
    tokenKey: "AUTHJS_TURSO_DATABASE_TOKEN",
    tables: ["session", "account", "verificationToken", "user"],
  },
};

async function resetTurso(app: "authjs" | "better-auth") {
  const { urlKey, tokenKey, tables } = TURSO[app];
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env[urlKey]!, authToken: process.env[tokenKey]! });

  const { rows } = await db.execute('select count(*) as n from "user"');
  console.log(`  ${rows[0].n} users in ${new URL(process.env[urlKey]!).hostname}`);
  if (!confirmed) return;

  // Children first; the tables are cleared in FK order so this works with or
  // without cascade enabled.
  for (const table of tables) await db.execute(`delete from "${table}"`);
  console.log(`    cleared ${tables.join(", ")}`);
}

const PLANS: Record<Exclude<Provider, "authjs" | "better-auth">, () => Promise<Plan>> = {
  clerk: planClerk,
  auth0: planAuth0,
  supabase: planSupabase,
  firebase: planFirebase,
  workos: planWorkos,
};

async function reset(provider: Provider) {
  console.log(`\n${provider}`);
  if (provider === "authjs" || provider === "better-auth") return resetTurso(provider);

  let plan = await PLANS[provider]();
  console.log(`  ${plan.ids.length}${plan.capped ? "+" : ""} users in ${plan.where}`);
  if (!plan.ids.length || !confirmed) return;
  // A capped listing is deleted and listed again until empty. Anything that
  // failed (throttling past the retries) comes back in a later listing.
  for (let round = 0; round < 100; round++) {
    await plan.remove(plan.ids);
    if (!plan.capped) return;
    const previous = new Set(plan.ids);
    // The search index lists deleted users for a while: wait for new ones to
    // surface rather than re-deleting the same 1,000. After 60s, whatever is
    // still listed is deleted again — that is how failures get retried.
    for (let wait = 0; wait < 12; wait++) {
      plan = await PLANS[provider]();
      if (!plan.ids.length) return;
      if (!plan.ids.every((id) => previous.has(id))) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error("still not empty after 100 rounds of deletes");
}

const targets = selectProviders("reset");
// Only a real reset changes anything; the dry run just counts.
if (confirmed) await lockProviders(targets, `bun reset.ts -p ${targets.join(",")}`);

if (!confirmed) console.log("Dry run — counting only. Add --yes (-y) to actually delete.");

for (const provider of targets) {
  try {
    await reset(provider);
  } catch (error) {
    console.error(`  skipped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

console.log(confirmed ? "\nDone." : "\nNothing was deleted. Re-run with --yes (-y).");
