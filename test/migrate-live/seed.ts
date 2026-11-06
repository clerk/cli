/**
 * Seeds users into every provider, or one of them.
 *
 *   bun seed.ts                          every provider except Clerk
 *   bun seed.ts -p workos                just that one
 *   bun seed.ts -k                       from data/users-10k.json
 *   bun seed.ts -p authjs -r             clear that app's tables first
 *
 * Clerk is excluded from a bare run on purpose: it is the destination every
 * other app migrates *to*, so it has to start empty. `--provider clerk` seeds
 * it anyway if you have a reason to.
 *
 * Each provider's seeder is a standalone script; this only chooses which ones
 * run. A failure is reported and the rest still run, with a non-zero exit at
 * the end.
 */
import { PROVIDERS, selectProviders, type Provider } from "./lib/providers";
import { lockProviders } from "./lib/lock";
import { usersFile } from "./lib/users";
import { flag, spell } from "./lib/args";

if (flag("help")) {
  console.log(
    `Usage: bun seed.ts [options]\n\n` +
      `  ${spell("provider").padEnd(18)} one of ${PROVIDERS.join(" ")}\n` +
      `  ${"".padEnd(18)} (default: all of them except clerk)\n` +
      `  ${spell("tenK").padEnd(18)} seed from data/users-10k.json\n` +
      `  ${spell("reset").padEnd(18)} clear existing rows first (Auth.js / Better Auth only)\n` +
      `  ${spell("help").padEnd(18)} this message`,
  );
  process.exit(0);
}

/** Both Turso apps live in one seeder, which reads --provider itself. */
const MODULES: Record<Provider, string> = {
  authjs: "./seed-turso",
  "better-auth": "./seed-turso",
  supabase: "./seed-supabase",
  firebase: "./seed-firebase",
  auth0: "./seed-auth0",
  workos: "./seed-workos",
  clerk: "./seed-clerk",
};

const selected = selectProviders("seed");
// Waits if another run is seeding, exporting or resetting one of these.
await lockProviders(selected, `bun seed.ts -p ${selected.join(",")}`);
// Dedupe: a default run picks both Turso apps, but that is a single seeder.
// Group the provider names back onto their module so the log says "authjs,
// better-auth" rather than the file it happens to live in.
const modules = new Map<string, Provider[]>();
for (const provider of selected)
  modules.set(MODULES[provider], [...(modules.get(MODULES[provider]) ?? []), provider]);

console.log(`Seeding ${selected.join(", ")} from ${usersFile()}\n`);

/**
 * A seeder reports trouble two different ways, and both have to be caught:
 * it throws (bad credentials, a guard refusing to overwrite), or it finishes
 * normally having failed on individual users — reportFailures sets
 * process.exitCode for that case. Reading only the exception would print
 * "Done." over a run that created nothing.
 */
const failed: string[] = [];
const partial: string[] = [];

for (const [module, names] of modules) {
  const label = names.join(", ");
  console.log(`── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}`);

  process.exitCode = 0;
  try {
    await import(module);
    if (process.exitCode) partial.push(label);
  } catch (error) {
    failed.push(label);
    console.error(`  failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log();
}

if (failed.length) console.error(`Did not run: ${failed.join(", ")}`);
if (partial.length)
  console.error(
    `Finished with user-level errors: ${partial.join(", ")}\n` +
      "  Re-seeding over existing users fails every one as a duplicate — " +
      "`bun reset.ts --provider <name> --yes` first.",
  );

process.exitCode = failed.length || partial.length ? 1 : 0;
if (!process.exitCode) console.log("Done.");
