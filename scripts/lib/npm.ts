const REGISTRY_URL = "https://registry.npmjs.org";

/**
 * Run a command asynchronously, throwing on non-zero exit.
 */
export async function run(cmd: string[], opts?: { cwd?: string }): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `${cmd.join(" ")} failed (exit ${exitCode})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Check if a package version is published on npm.
 *
 * Reads the per-version document (`/<name>/<version>`) straight from the
 * registry instead of going through `npm view`. `npm view` fetches the whole
 * packument, which the registry CDN and npm's local cache both hold for five
 * minutes (`cache-control: max-age=300`), so a version published moments ago
 * reads as missing. The per-version document is not CDN-cached.
 *
 * Distinguishes "not found" (404) from real errors, retrying transient ones.
 */
export async function isPublished(
  name: string,
  version: string,
  opts: { fetch?: Fetch; attempts?: number; retryDelayMs?: number } = {},
): Promise<boolean> {
  const fetchImpl = opts.fetch ?? fetch;
  const attempts = opts.attempts ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 1_000;
  const url = `${REGISTRY_URL}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { accept: "application/json", "cache-control": "no-cache" },
      });
      if (res.status === 200) return true;
      if (res.status === 404) return false;
      lastError = new Error(`GET ${url} returned ${res.status}`);
      // Anything other than a rate limit or server error will not fix itself.
      if (res.status !== 429 && res.status < 500) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await Bun.sleep(retryDelayMs * attempt);
  }
  throw new Error(`Could not check whether ${name}@${version} is published`, {
    cause: lastError,
  });
}

/**
 * Whether an npm publish failure means the version already exists, which
 * happens when an earlier attempt's publish landed but that attempt failed
 * later (or its read-back had not caught up yet).
 */
export function isAlreadyPublishedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /cannot publish over (the )?previously published version/i.test(error.message)
  );
}

/**
 * Publish a package directory to npm. Treats "version already exists" as
 * success so a re-run finishes what an earlier attempt started.
 */
export async function publish(
  dir: string,
  opts: { dryRun: boolean; tag?: string },
): Promise<"published" | "already-published"> {
  const flags = ["npm", "publish", "--access", "public", "--provenance", "--ignore-scripts"];
  if (opts.tag) flags.push("--tag", opts.tag);
  if (opts.dryRun) flags.push("--dry-run");
  try {
    await run(flags, { cwd: dir });
    return "published";
  } catch (error) {
    if (isAlreadyPublishedError(error)) return "already-published";
    throw error;
  }
}

/**
 * Wait until npm reports that a package version has been published.
 */
export async function waitUntilPublished(
  name: string,
  version: string,
  opts: {
    intervalMs: number;
    timeoutMs: number;
    isPublished: (name: string, version: string) => Promise<boolean>;
  },
): Promise<void> {
  const startedAt = Date.now();

  while (true) {
    if (await opts.isPublished(name, version)) {
      return;
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= opts.timeoutMs) {
      throw new Error(
        `Timed out waiting for ${name}@${version} to become available on npm after ${opts.timeoutMs}ms`,
      );
    }

    await Bun.sleep(Math.min(opts.intervalMs, opts.timeoutMs - elapsedMs));
  }
}
