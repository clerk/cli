import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { $ } from "bun";

const is1PasswordInstalled = await $`op --version`
  .then((res) => res.exitCode === 0)
  .catch(() => false);

if (!is1PasswordInstalled) {
  throw new Error("1Password CLI is not installed. Install it with `brew install 1password-cli`.");
}

const envItem = await $`op read 'op://Shared/CLI env profiles/.env-profiles.json'`
  .then((res) => {
    if (res.exitCode === 0) {
      return res.stdout;
    }

    return null;
  })
  .catch(() => {
    return null;
  });

if (!envItem) {
  throw new Error(
    "Failed to read from 1Password. Have you enabled the 1Password CLI in your 1Password settings? See https://developer.1password.com/docs/cli/get-started/#step-2-turn-on-the-1password-desktop-app-integration for more information.",
  );
}

await writeFile(join(process.cwd(), ".env-profiles.json"), envItem);
