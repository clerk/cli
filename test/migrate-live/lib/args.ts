/**
 * Long and short forms for every flag the seed/reset/generate scripts take.
 * One table so `-p` means the same thing everywhere and nothing drifts.
 */
export const FLAGS = {
  provider: ["--provider", "-p"],
  reset: ["--reset", "-r"],
  yes: ["--yes", "-y"],
  tenK: ["--10k", "-k"],
  help: ["--help", "-h"],
  count: ["--count", "-c"],
  out: ["--out", "-o"],
  dryRun: ["--dry-run", "-n"],
  app: ["--app", "-a"],
  /* `-p` is `provider` for seed/reset and `production` for teardown. The two
   * never run in the same script, so the overlap is safe — but it is the one
   * exception to "same letter, same meaning" and worth knowing about. */
  production: ["--production", "-p"],
  cli: ["--cli"],
  variation: ["--variation", "-v"],
  dest: ["--dest", "-d"],
  target: ["--target", "-t"],
  export: ["--export", "-e"],
  source: ["--source", "-s"],
  all: ["--all"],
  sourcesDir: ["--sources-dir"],
  set: ["--set"],
  agentCli: ["--agent-cli"],
  /* `-a` is `app` for teardown and `agents` for the evals; like `-p`, the two
   * never run in the same script. */
  agents: ["--agents", "--agent", "-a"],
  exports: ["--exports"],
  promptDir: ["--prompt-dir"],
  lenient: ["--lenient"],
  expect: ["--expect"],
  usersFile: ["--users-file"],
  seedOnly: ["--seed-only"],
  restoreSource: ["--restore-source"],
  exportTo: ["--export-to"],
  noSync: ["--no-sync"],
  native: ["--native"],
  done: ["--done"],
} as const;

type Name = keyof typeof FLAGS;

/** True when the flag is present in either form. */
export function flag(name: Name): boolean {
  return FLAGS[name].some((f) => process.argv.includes(f));
}

/** The value after the flag, in either form. */
export function value(name: Name): string | undefined {
  const i = process.argv.findIndex((a) => (FLAGS[name] as readonly string[]).includes(a));
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** "--provider, -p" — for usage lines. */
export const spell = (name: Name) => FLAGS[name].join(", ");
