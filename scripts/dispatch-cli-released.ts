/**
 * Dispatch a stable CLI release event after publishing.
 *
 * Usage:
 *   CLERK_CLI_VERSION=1.2.3 CLERK_CLI_DISPATCH_TOKEN="$DISPATCH_TOKEN" bun scripts/dispatch-cli-released.ts
 */

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export function assertStableVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Expected a stable Clerk CLI version, got ${JSON.stringify(version)}`);
  }
}

export async function sendCliReleaseDispatch(
  version: string,
  token: string,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  assertStableVersion(version);
  if (!token) throw new Error("CLERK_CLI_DISPATCH_TOKEN is not configured");

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

if (import.meta.main) {
  const version = process.env.CLERK_CLI_VERSION ?? "";
  const token = process.env.CLERK_CLI_DISPATCH_TOKEN ?? "";
  await sendCliReleaseDispatch(version, token);
  console.log(`Sent clerk_cli_released for clerk@${version} to clerk/clerk-evals`);
}
