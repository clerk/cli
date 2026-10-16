/** Notify the add-auth eval receiver only after a stable CLI release is npm latest. */

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export function assertStableVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Expected a stable Clerk CLI version, got ${JSON.stringify(version)}`);
  }
}

export async function waitForNpmLatest(
  version: string,
  opts: {
    readLatest: () => Promise<string>;
    sleep: (ms: number) => Promise<void>;
    attempts?: number;
    intervalMs?: number;
  },
): Promise<void> {
  assertStableVersion(version);
  const attempts = opts.attempts ?? 12;
  const intervalMs = opts.intervalMs ?? 30_000;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const latest = await opts.readLatest();
    if (latest === version) return;
    console.log(`npm latest is ${latest}; waiting for clerk@${version} (${attempt}/${attempts})`);
    if (attempt < attempts) await opts.sleep(intervalMs);
  }

  throw new Error(
    `clerk@${version} was published but did not become npm latest after ${attempts} checks`,
  );
}

export async function sendCliReleaseDispatch(
  version: string,
  token: string,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  assertStableVersion(version);
  if (!token) throw new Error("CLERK_EVALS_DISPATCH_TOKEN is not configured");

  const response = await fetchImpl("https://api.github.com/repos/clerk/clerk-evals/dispatches", {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ event_type: "clerk_cli_released", client_payload: { version } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 204) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(
      `clerk-evals dispatch returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
}

async function npmLatestVersion(): Promise<string> {
  const proc = Bun.spawn(["npm", "view", "clerk@latest", "version", "--prefer-online"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exit !== 0) throw new Error(`npm view clerk@latest failed: ${stderr.trim()}`);
  return stdout.trim();
}

if (import.meta.main) {
  const version = process.env.CLERK_CLI_VERSION ?? "";
  const token = process.env.CLERK_EVALS_DISPATCH_TOKEN ?? "";
  if (!token) throw new Error("CLERK_EVALS_DISPATCH_TOKEN is not configured");
  await waitForNpmLatest(version, { readLatest: npmLatestVersion, sleep: Bun.sleep });
  await sendCliReleaseDispatch(version, token);
  console.log(`Sent clerk_cli_released for clerk@${version} to clerk/clerk-evals`);
}
