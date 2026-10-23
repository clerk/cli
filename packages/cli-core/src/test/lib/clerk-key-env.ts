/**
 * Isolates tests from Clerk keys exported in the developer's or CI's shell.
 *
 * The key readers in `lib/local-keys.ts` read the shell before any file, under
 * every name in `CLERK_KEY_NAMES`. A test that doesn't clear those names gets a
 * machine-dependent result, and a failing whole-object assertion prints the
 * exported value. Use `useCleanClerkKeyEnv()` in every block that reads keys.
 */

import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { CLERK_KEY_NAMES } from "../../lib/framework.ts";

/** Every shell variable a Clerk key can be read from. */
export const CLERK_KEY_ENV_NAMES: readonly string[] = [
  ...CLERK_KEY_NAMES.publishable,
  ...CLERK_KEY_NAMES.secret,
];

function saveAndSet(values: Record<string, string | undefined>): Map<string, string | undefined> {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return saved;
}

function restore(saved: Map<string, string | undefined>): void {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/**
 * Clears every Clerk key variable before each test and restores it after.
 * Clearing before, not only after, stops a pre-set shell value from deciding
 * the first test. Register at file or `describe` scope.
 */
export function useCleanClerkKeyEnv(): void {
  let saved = new Map<string, string | undefined>();
  beforeEach(() => {
    saved = saveAndSet(Object.fromEntries(CLERK_KEY_ENV_NAMES.map((name) => [name, undefined])));
  });
  afterEach(() => {
    restore(saved);
  });
}

/**
 * Exports a synthetic, key-shaped value under every Clerk key variable for the
 * whole file, standing in for a developer's shell. A block that forgets
 * `useCleanClerkKeyEnv()` then fails on a synthetic value, never a real one.
 */
export function useSyntheticShellClerkKeys(): void {
  let saved = new Map<string, string | undefined>();
  beforeAll(() => {
    saved = saveAndSet(
      Object.fromEntries([
        ...CLERK_KEY_NAMES.publishable.map((name) => [name, `pk_test_synthetic_shell_${name}`]),
        ...CLERK_KEY_NAMES.secret.map((name) => [name, `sk_test_synthetic_shell_${name}`]),
      ]),
    );
  });
  afterAll(() => {
    restore(saved);
  });
}
