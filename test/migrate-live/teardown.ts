/**
 * Resets a Clerk migration-test instance back to its baseline so the next round
 * of testing starts from a known state. Wraps the Clerk CLI — nothing here talks
 * to the Backend API directly, so whatever `clerk whoami` is signed in as is what
 * gets changed.
 *
 *   bun run test:migrate-live:teardown                      pick an instance, confirm before deleting
 *   bun run test:migrate-live:teardown -y                   skip the "delete N users?" prompt
 *   bun run test:migrate-live:teardown -n                   dry run: links, then reports without changing
 *   bun run test:migrate-live:teardown --all                every instance in the account, one confirmation
 *   bun run test:migrate-live:teardown --cli <path/to/cli.ts>   run a local CLI build via bun
 *
 * --cli swaps `clerk ...` for `bun --env-file=<cli>/.env.local <path> ...` and
 * changes nothing else. The env file is found by walking up from cli.ts. A local
 * build talks to a local backend and frontend API, so it sees a different set of
 * applications than the hosted CLI — expect different app ids there.
 *
 * A dry run still runs `clerk link`, because the whole point of the link step is
 * that `clerk doctor` and bare `clerk` commands afterwards point at the instance
 * you picked. Nothing else is touched.
 *
 * The instance picker is built from `clerk apps list`, so it only ever offers
 * instances that actually exist — a production instance shows up the run after it
 * is created, and an app without one simply contributes one row instead of two.
 *
 * This deletes every user in the selected instance. There is no undo, so the
 * app name and environment are printed before anything is touched.
 */
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pool, progressBar } from "./lib/users";
import { flag, spell, value } from "./lib/args";

/** The two apps this repo migrates into. Anything else is a wrong-account signal. */
const REQUIRED_APPS = ["app_3JVnO515SfI9c8lo2l3KskmG7MQ", "app_3HYFnu4WUmQ1p5DS301lefhySiO"];
/** Test and eval apps share this name prefix; only they are offered for teardown. */
const TEST_APP_PREFIX = "Migration Testing - ";

if (flag("help")) {
  console.log(
    `Usage: bun run test:migrate-live:teardown [options]\n\n` +
      `  ${spell("app").padEnd(18)} app id to target; skips the picker\n` +
      `  ${spell("production").padEnd(18)} target the production instance (default: development)\n` +
      `  ${spell("all").padEnd(18)} every test instance (with -p, every production one);\n` +
      `  ${"".padEnd(18)} the picker's "a" option does the same\n` +
      `  ${spell("yes").padEnd(18)} skip confirmations (deleting users, and the local\n` +
      `  ${"".padEnd(18)} app list under --cli)\n` +
      `  ${spell("dryRun").padEnd(18)} show what would change without touching anything\n` +
      `  ${spell("cli").padEnd(18)} path to a local cli.ts to run with bun, instead of\n` +
      `  ${"".padEnd(18)} the installed \`clerk\` (points at a local backend)\n` +
      `  ${spell("help").padEnd(18)} this message\n\n` +
      `Fully non-interactive:\n` +
      `  bun run test:migrate-live:teardown -a ${REQUIRED_APPS[0]} -p -y`,
  );
  process.exit(0);
}

/*
 * Either the installed `clerk`, or `bun <path>` for a local build. A quoted `~`
 * survives the shell, so expand it here — execFileSync runs no shell of its own.
 */
const localCli = value("cli")?.replace(/^~(?=$|\/)/, homedir());
const cliPath = localCli ? resolve(localCli) : undefined;

if (cliPath && !existsSync(cliPath)) {
  console.error(
    `No CLI entrypoint at ${cliPath}\n(--cli wants the path to cli.ts, without the \`bun\`)`,
  );
  process.exit(1);
}

/**
 * A local build reads its backend and frontend API hosts from `.env.local` at the
 * CLI package root, which is a few directories above cli.ts. Without it bun starts
 * the CLI with no env and it talks to the hosted Clerk instead of the local one —
 * so this is derived rather than assumed, and a miss is fatal rather than silent.
 */
function findEnvFile(from: string): string {
  for (let dir = dirname(from), i = 0; i < 8; i++) {
    const candidate = join(dir, ".env.local");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || dir === homedir()) break;
    dir = parent;
  }
  throw new Error(
    `No .env.local found above ${from}.\n` +
      `A local CLI needs it to reach the local backend and frontend API.`,
  );
}

const bin = cliPath ? "bun" : "clerk";
const prefix = cliPath ? [`--env-file=${findEnvFile(cliPath)}`, cliPath] : [];
/** How to spell this CLI in a message the reader is meant to run themselves. */
const cliName = [bin, ...prefix].join(" ");

/**
 * Runs the CLI and hands back stdout.
 *
 * `--mode agent` is pinned rather than left to the CLI's TTY auto-detection: in
 * human mode `clerk apps list` renders a table instead of JSON, and `clerk config
 * patch` stops on a confirmation prompt. Both depend on whether stdout happens to
 * be a terminal, which is not something this script should be at the mercy of.
 */
function clerk(...args: string[]): string {
  return execFileSync(bin, [...prefix, "--mode", "agent", ...args], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Same, but a non-zero exit is not fatal — the output is still wanted. `doctor`
 * exits 1 whenever a check fails, and a failing check is precisely what this
 * script reads it for: a directory linked to an app the current backend cannot
 * reach is the thing the link step goes on to fix.
 */
function clerkOutput(...args: string[]): string {
  try {
    return clerk(...args);
  } catch (error) {
    return (error as { stdout?: string }).stdout ?? "";
  }
}

/**
 * The CLI prints a status line before the JSON on some commands ("Pulling config
 * from ..."), so parse from the first brace or bracket rather than the first byte.
 */
function clerkJson<T>(...args: string[]): T {
  const out = clerk(...args);
  const start = out.search(/[[{]/);
  if (start < 0) throw new Error(`clerk ${args.join(" ")} returned no JSON:\n${out}`);
  return JSON.parse(out.slice(start)) as T;
}

const dryRun = flag("dryRun");

/* Opened on first use — a fully flagged run never prompts and should not hold stdin. */
let rl: ReturnType<typeof createInterface> | undefined;

/*
 * `rl.question` never settles once stdin reaches EOF, which leaves the script to
 * die on Node's "unsettled top-level await" warning. Racing the close event turns
 * a closed or exhausted stdin into a sentence that says what to do instead.
 */
const ask = async (q: string) => {
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string | null>((done) => {
    rl!.question(q).then(done, () => done(null));
    rl!.once("close", () => done(null));
  });
  if (answer === null) {
    console.error(
      `\nNo answer on stdin. For an unattended run see \`bun run test:migrate-live:teardown --help\`.`,
    );
    process.exit(1);
  }
  return answer.trim();
};

// 1. Signed in?
type WhoAmI = { email?: string };
let me: WhoAmI | undefined;
try {
  me = clerkJson<WhoAmI>("whoami", "--json");
} catch {
  /* A local build keeps its own session against its own backend, so the command
   * to fix this is whichever CLI we are actually driving. */
}
if (!me?.email) {
  console.error(`Not signed in. Run \`${cliName} auth login\`, then try again.`);
  process.exit(1);
}
console.log(`Signed in as ${me.email}${cliPath ? ` (local CLI: ${cliPath})` : ""}`);

// 2. Confirm the account holds the apps this is allowed to touch.
type App = {
  application_id: string;
  name: string;
  instances: { instance_id: string; environment_type: string }[];
};
const apps = clerkJson<App[]>("apps", "list");

/*
 * Against hosted Clerk the two target apps are known, so their absence means the
 * wrong account and nothing else is offered. A local backend is built by whoever
 * is running it — any number of apps, any names, any ids — so there is nothing to
 * match against. The guarantee is kept by showing what was found and making the
 * reader agree to it before anything is picked.
 */
let inScope: App[];
if (cliPath) {
  if (!apps.length) {
    console.error(`No applications on the local backend (signed in as ${me.email}).`);
    process.exit(1);
  }
  console.log(`\nApplications on this local backend:\n`);
  for (const a of apps)
    console.log(
      `  ${a.name}\n     ${a.application_id}  ${a.instances.map((i) => i.environment_type).join(", ")}`,
    );

  const ok =
    flag("yes") || (await ask(`\nIs that the right account? [y/N] `)).toLowerCase() === "y";
  if (!ok) {
    console.log("Stopping — sign in to the right account and run again.");
    rl?.close();
    process.exit(1);
  }
  inScope = apps;
} else {
  const missing = REQUIRED_APPS.filter((id) => !apps.some((a) => a.application_id === id));
  if (missing.length) {
    console.error(
      `These apps are not in your account:\n${missing.map((id) => `  ${id}`).join("\n")}\n` +
        `Signed in as ${me.email} — is that the right account?`,
    );
    process.exit(1);
  }
  /* The two known apps prove the account. Every test/eval app is offered, those
   * two first; they are all named "Migration Testing - ...". Anything else in
   * the account (the migrate-baseline-* fixtures) holds users worth keeping. */
  inScope = [
    ...REQUIRED_APPS.map((id) => apps.find((a) => a.application_id === id)!),
    ...apps.filter(
      (a) => a.name.startsWith(TEST_APP_PREFIX) && !REQUIRED_APPS.includes(a.application_id),
    ),
  ];
}

// 3. Pick instances from what actually exists.
type Target = { appId: string; appName: string; env: string; instanceId: string };
const targets: Target[] = inScope.flatMap((app) =>
  app.instances.map((i) => ({
    appId: app.application_id,
    appName: app.name,
    env: i.environment_type,
    instanceId: i.instance_id,
  })),
);

const describe = (t: Target) => `${t.appName} — ${t.env}\n     ${t.appId}  ${t.instanceId}`;

/* --production names the environment for an --app lookup. On its own it only
 * narrows the picker (or --all): bare `bun run test:migrate-live:teardown` has no environment
 * preference and must offer every instance, production included. */
const prodOnly = flag("production");
const wantEnv = prodOnly ? "production" : "development";
const wantApp = value("app");

if (wantApp && flag("all")) {
  console.error(`--app and --all pick different things. Use one.`);
  process.exit(1);
}

let chosen: Target[];
if (wantApp) {
  const target = targets.find((t) => t.appId === wantApp && t.env === wantEnv);
  if (!target) {
    console.error(
      `No ${wantEnv} instance for ${wantApp}. What exists:\n` +
        targets.map((t) => `  ${describe(t)}`).join("\n"),
    );
    process.exit(1);
  }
  chosen = [target];
} else {
  const choices = prodOnly ? targets.filter((t) => t.env === "production") : targets;
  if (flag("all")) {
    chosen = choices;
  } else {
    console.log(`\nWhich ${prodOnly ? "production " : ""}instance should be torn down?\n`);
    choices.forEach((t, i) => console.log(`  ${i + 1}. ${describe(t)}`));
    console.log(`  a. All ${choices.length} of the above`);

    const answer = await ask(`\nPick 1-${choices.length}, or a for all: `);
    const picked = choices[Number(answer) - 1];
    chosen = /^a(ll)?$/i.test(answer) ? choices : picked ? [picked] : [];
    if (!chosen.length) {
      console.error(`"${answer}" is not one of the options.`);
      rl?.close();
      process.exit(1);
    }
  }
}

/*
 * A batch asks once, up front, with the whole list on screen — not once per
 * instance, which would be a couple of dozen prompts to "y" through blind.
 */
const many = chosen.length > 1;
if (many) {
  console.log(`\nTearing down ${chosen.length} instances:\n`);
  chosen.forEach((t) => console.log(`  ${describe(t)}`));
  const ok =
    dryRun ||
    flag("yes") ||
    (
      await ask(
        `\nDelete every user in all ${chosen.length} and reset their config? This cannot be undone. [y/N] `,
      )
    ).toLowerCase() === "y";
  if (!ok) {
    console.log("Stopping — nothing was changed.");
    rl?.close();
    process.exit(1);
  }
}

async function teardown(target: Target) {
  /* `--instance` takes dev/prod, not the environment_type spelling from apps list. */
  const instanceFlag = target.env === "production" ? "prod" : "dev";
  console.log(`\nTarget: ${target.appName} (${target.env}) ${target.instanceId}`);

  // 4. Link this directory to the chosen app if it is pointed somewhere else.
  /* Skipped for a batch: there is no one app to point `clerk doctor` at, and
   * every call below names its app and instance explicitly anyway. */
  if (!many) {
    const doctor = clerkOutput("doctor", "--json");
    const linkedApp = doctor
      .slice(Math.max(doctor.search(/[[{]/), 0))
      .match(/"name":\s*"Application reachable"[\s\S]*?(app_[A-Za-z0-9]+)/)?.[1];

    if (linkedApp === target.appId) {
      console.log(`Already linked to ${target.appId}.`);
    } else {
      /* Linked even under --dry-run: it only moves a local pointer, and leaving it
       * stale makes `clerk doctor` report the wrong app for the rest of the session. */
      console.log(`Linked to ${linkedApp ?? "nothing"} — relinking to ${target.appId}...`);
      clerk("link", "--app", target.appId);
    }
  }

  const scope = ["--app", target.appId, "--instance", instanceFlag];

  // 5. Users.
  const { total_count: userCount } = clerkJson<{ total_count: number }>(
    "api",
    "/users/count",
    ...scope,
  );
  if (userCount === 0) {
    console.log("\nNo users to delete.");
  } else {
    console.log(`\n${userCount} user(s) in ${target.appName} (${target.env}).`);
    const ok =
      !dryRun &&
      (flag("yes") ||
        many ||
        (await ask("Delete all of them? This cannot be undone. [y/N] ")).toLowerCase() === "y");

    if (!ok) {
      console.log(dryRun ? "[dry-run] would delete all of them." : "Leaving users in place.");
    } else {
      /*
       * Collect every id before deleting any — paging while deleting shifts the
       * offset out from under the next page and silently skips records.
       */
      const ids: string[] = [];
      for (let offset = 0; ; offset += 500) {
        const page = clerkJson<{ id: string }[]>(
          "api",
          `/users?limit=500&offset=${offset}`,
          ...scope,
        );
        if (!page.length) break;
        ids.push(...page.map((u) => u.id));
      }

      const failures = await pool(
        ids,
        4,
        async (id) => void clerk("api", "-X", "DELETE", `/users/${id}`, "--yes", ...scope),
        progressBar("deleted"),
      );
      if (failures.length) {
        console.error(`\n${failures.length} user(s) failed to delete. First few:`);
        for (const { item, error } of failures.slice(0, 5))
          console.error(`  ${item}: ${String(error).slice(0, 200)}`);
        process.exitCode = 1;
      }
    }
  }

  // 6. Enterprise SSO connections (SAML/OIDC) are separate records, not config keys.
  const { data: enterprise } = clerkJson<{ data: { id: string; name?: string }[] }>(
    "api",
    "/enterprise_connections",
    ...scope,
  );
  for (const c of enterprise) {
    console.log(
      `${dryRun ? "[dry-run] would delete" : "Deleting"} enterprise connection ${c.name ?? c.id}`,
    );
    if (dryRun) continue;
    clerk("api", "-X", "DELETE", `/enterprise_connections/${c.id}`, "--yes", ...scope);
  }

  // 7. Instance config. Read first so only the keys that are actually wrong get patched.
  type Config = Record<string, Record<string, unknown> | null>;
  const config = clerkJson<Config>("config", "pull", ...scope);

  const patch: Record<string, unknown> = {
    // Phone: not addable, not a sign-in or sign-up identifier, not a second factor.
    auth_phone: {
      used_for_sign_in: false,
      used_for_sign_up: false,
      required_for_sign_up: false,
      used_for_second_factor: false,
      verify_at_sign_up: false,
      sign_in_strategies: [],
      second_factor_strategies: [],
      verification_strategies: [],
    },
    auth_username: {
      used_for_sign_in: false,
      used_for_sign_up: false,
      required_for_sign_up: false,
    },
    // `enabled: false` removes passwords entirely; `required` covers sign-up on its own.
    auth_password: { enabled: false, required: false },
    /* Biometrics are passkeys in Clerk — there is no separate biometric attribute,
     * so every passkey switch that gates availability goes off. The fourth field,
     * satisfies_second_factor, is not one of them: it says whether a passkey counts
     * as 2FA, and the API rejects setting it false (409 invalid auth configuration). */
    auth_passkey: { used_for_sign_in: false, allow_autofill: false, show_sign_in_button: false },
    // Names stay collectable, just never mandatory.
    user_model: {
      first_name: { enabled: true, required: false },
      last_name: { enabled: true, required: false },
    },
    // Email is the only identifier left: required, verified at sign-up, code not link.
    auth_email: {
      used_for_sign_up: true,
      required_for_sign_up: true,
      verify_at_sign_up: true,
      used_for_sign_in: true,
      sign_in_strategies: ["email_code"],
      verification_strategies: ["email_code"],
      immutable: false, // users can change their email address after sign-up
    },
    auth_multi_factor: {
      authenticator_app: { enabled: false },
      backup_code: { enabled: false },
      required_for_sign_in: false,
      required_for_sign_up: false,
    },
    auth_web3: {
      used_for_sign_in: false,
      used_for_sign_up: false,
      required_for_sign_up: false,
      verify_at_sign_up: false,
      sign_in_strategies: [],
      verification_strategies: [],
    },
    organization_settings: { enabled: false },
    billing: { organization_enabled: false, user_enabled: false },
  };

  /* Read the provider list off the instance rather than hardcoding it, so a
   * provider Clerk adds later still gets switched off. */
  for (const [key, value] of Object.entries(config)) {
    if (!key.startsWith("connection_oauth_") || key === "connection_oauth_google") continue;
    if (value?.enabled) patch[key] = { enabled: false };
  }
  for (const [key, value] of Object.entries(config.connections_oauth_custom ?? {})) {
    if ((value as { enabled?: boolean } | null)?.enabled)
      patch.connections_oauth_custom = {
        ...(patch.connections_oauth_custom as object),
        [key]: { enabled: false },
      };
  }

  /*
   * Google is the one connection that stays. In development, Clerk supplies shared
   * credentials, so enabling it needs nothing else. In production it would need
   * real OAuth credentials this script has no way to supply, so a disabled
   * production Google connection is left disabled.
   */
  const googleEnabled = Boolean(config.connection_oauth_google?.enabled);
  if (!googleEnabled) {
    if (instanceFlag === "dev") patch.connection_oauth_google = { enabled: true };
    else
      console.log(
        "Google is disabled in production — leaving it off (needs real OAuth credentials).",
      );
  }

  console.log("\nApplying config...");
  const result = clerk(
    "config",
    "patch",
    "--json",
    JSON.stringify(patch),
    ...scope,
    ...(dryRun ? ["--dry-run"] : []),
  );
  /* The CLI prints a readable diff and then dumps the whole before/after config.
   * Keep the diff, drop the dump. */
  const dump = result.search(/^\{/m);
  process.stdout.write(dump < 0 ? result : result.slice(0, dump));
  /*
   * "Users can delete their account" is not in the config schema, and neither the
   * Backend API nor the Platform API accepts it — PATCH /instance and
   * PATCH /beta_features/instance_settings both take the field and ignore it. The
   * only place it reads back is the public FAPI environment payload, so check it
   * there and hand the fix back rather than reporting a reset that did not happen.
   */
  let deleteSelf: boolean | undefined;
  try {
    const raw = clerkOutput("api", "--fapi", "/environment", ...scope);
    deleteSelf = JSON.parse(raw.slice(raw.search(/[[{]/))).user_settings.actions.delete_self;
  } catch {
    /* FAPI is reached over the instance's own domain, which a throwaway instance on
     * a local backend may not actually serve. Unknown is reported, never fatal. */
  }

  if (deleteSelf === undefined)
    console.log(
      `\n  Could not read the public environment payload — "users can delete their\n  account" was left unverified.`,
    );
  else if (!deleteSelf)
    console.warn(
      `\n  Users cannot delete their own account, and no CLI command can change it.\n` +
        `  Turn it on by hand: clerk open dashboard`,
    );

  console.log(
    dryRun
      ? "\n[dry-run] nothing was changed. Re-run without --dry-run to apply."
      : `\nDone. ${target.appName} (${target.env}) is back to the test baseline.`,
  );
}

/* One instance failing (a 409 on config, a network blip) should not strand the
 * rest of a batch half-reset. A single target keeps the old fail-fast. */
const failed: Target[] = [];
for (const target of chosen) {
  try {
    await teardown(target);
  } catch (error) {
    if (!many) throw error;
    console.error(`\nFailed: ${target.appName} (${target.env}): ${String(error).slice(0, 300)}`);
    failed.push(target);
    process.exitCode = 1;
  }
}
if (many)
  console.log(
    failed.length
      ? `\n${chosen.length - failed.length} of ${chosen.length} done. Failed:\n` +
          failed.map((t) => `  ${describe(t)}`).join("\n")
      : `\nAll ${chosen.length} instances done.`,
  );
rl?.close();
