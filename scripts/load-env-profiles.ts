import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureOpInstalled, readOpItem } from "./lib/op.ts";

await ensureOpInstalled();

const envItem = await readOpItem("op://Shared/CLI env profiles/.env-profiles.json");

await writeFile(join(process.cwd(), ".env-profiles.json"), envItem);
