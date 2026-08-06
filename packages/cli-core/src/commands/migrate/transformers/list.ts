/**
 * `clerk migrate transformers list` — which source platforms are available.
 *
 * New in the CLI. The standalone tool's interactive picker was the only place
 * these were listed, which was fine when the user had the source tree to grep.
 * A compiled binary's users have neither, so the list is a command.
 */

import { bold, cyan, dim } from "../../../lib/color.ts";
import { log } from "../../../lib/log.ts";
import type { TransformerRegistryEntry } from "../types.ts";
import { loadCustomTransformer } from "./load-custom.ts";
import { transformers } from "./registry.ts";

export type TransformersListOptions = {
  json?: boolean;
  transformerFile?: string;
};

type Listed = TransformerRegistryEntry & { builtIn: boolean; source?: string };

function toJson(entries: Listed[]) {
  return entries.map((entry) => ({
    key: entry.key,
    label: entry.label,
    description: entry.description,
    built_in: entry.builtIn,
    ...(entry.source ? { source: entry.source } : {}),
    maps_to_user_id:
      Object.entries(entry.transformer).find(([, target]) => target === "userId")?.[0] ?? null,
  }));
}

export async function list(options: TransformersListOptions = {}): Promise<void> {
  const entries: Listed[] = transformers.map((entry) => ({ ...entry, builtIn: true }));

  if (options.transformerFile) {
    const custom = await loadCustomTransformer(options.transformerFile);
    entries.push({ ...custom, builtIn: false, source: options.transformerFile });
  }

  if (options.json) {
    log.data(JSON.stringify(toJson(entries), null, 2));
    return;
  }

  for (const entry of entries) {
    const suffix = entry.builtIn ? "" : ` ${dim(`(custom — ${entry.source})`)}`;
    log.info(`${cyan(bold(entry.key))}  ${entry.label}${suffix}`);
    log.info(`  ${dim(entry.description)}`);
    log.info("");
  }

  const custom = entries.length - transformers.length;
  log.info(
    dim(
      `${transformers.length} built-in transformer${transformers.length === 1 ? "" : "s"}` +
        (custom > 0 ? ` plus ${custom} loaded from --transformer-file` : ""),
    ),
  );

  if (custom === 0) {
    log.info(
      dim("Migrating from something else? Write a transformer and pass --transformer-file."),
    );
  }
}
