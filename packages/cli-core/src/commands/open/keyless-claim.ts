/**
 * Where `clerk open` sends an unclaimed keyless application.
 *
 * A keyless app belongs to no account yet, so the normal dashboard deep-link
 * (`/apps/{appId}/instances/{instanceId}/...`) 404s — there is no appId to
 * put in it. The only page that reliably exists for it is the one-time claim
 * link, which is why this module looks for that instead of reusing
 * `buildDashboardUrl`.
 */

import { join } from "node:path";
import { readKeylessBreadcrumb } from "../../lib/keyless.ts";
import { getDashboardUrl } from "../../lib/environment.ts";
import { bapiRequest } from "../../lib/bapi.ts";
import { log } from "../../lib/log.ts";

export interface KeylessClaimDestination {
  url: string;
  /** Where the claim link came from, for display (mirrors `KeylessTarget.source`). */
  source: string;
}

/** Best-effort instance metadata for display only — never blocks the claim link. */
export interface KeylessInstanceInfo {
  instanceId: string | null;
  environmentType: string | null;
}

const SDK_KEYLESS_FILE = [".clerk", ".tmp", "keyless.json"];

/**
 * The SDKs write their own full `claimUrl` (already pointed at the right
 * dashboard host) into this file. Reading it directly here — rather than
 * through `lib/keyless-target.ts` — because that module only surfaces the
 * key pair it needs for BAPI calls, not the claim URL.
 */
async function readSdkClaimUrl(cwd: string): Promise<string | undefined> {
  const file = Bun.file(join(cwd, ...SDK_KEYLESS_FILE));
  if (!(await file.exists())) return undefined;

  try {
    const parsed = (await file.json()) as { claimUrl?: unknown };
    const claimUrl = typeof parsed.claimUrl === "string" ? parsed.claimUrl : undefined;
    if (!claimUrl) return undefined;

    // Written by another process, so untrusted input: anything but well-formed
    // https is dropped rather than handed to the browser launcher — which on
    // Windows goes through `cmd /c start "" "<url>"`, where a `file:`/
    // `javascript:` scheme or an embedded quote stops being just a URL.
    let isHttps = false;
    try {
      isHttps = new URL(claimUrl).protocol === "https:";
    } catch {
      // fall through: not a URL at all
    }
    if (!isHttps) {
      log.debug(`open: ignoring non-https claimUrl in ${SDK_KEYLESS_FILE.join("/")}`);
      return undefined;
    }
    return claimUrl;
  } catch {
    // A half-written file during an SDK refresh isn't worth failing over.
    return undefined;
  }
}

/**
 * Finds the claim link for an unclaimed keyless application, checking both
 * places one can turn up depending on how keyless mode was entered:
 *
 *  - `clerk init --keyless` writes only the claim TOKEN to `.clerk/keyless.json`
 *    (see `writeKeylessBreadcrumb`); the URL is rebuilt against whichever
 *    dashboard host the CLI is currently pointed at.
 *  - An SDK that self-provisions (e.g. `next dev` with no keys configured)
 *    writes the full URL straight into `.clerk/.tmp/keyless.json`, so that one
 *    is used verbatim rather than reconstructed.
 *
 * Returns `undefined` when neither file has a usable claim link.
 */
export async function findKeylessClaimUrl(
  cwd: string,
): Promise<KeylessClaimDestination | undefined> {
  const sdkClaimUrl = await readSdkClaimUrl(cwd);
  if (sdkClaimUrl) {
    return { url: sdkClaimUrl, source: SDK_KEYLESS_FILE.join("/") };
  }

  const breadcrumb = await readKeylessBreadcrumb(cwd);
  if (breadcrumb) {
    const host = getDashboardUrl().replace(/\/$/, "");
    return {
      url: `${host}/apps/claim?token=${encodeURIComponent(breadcrumb.claimToken)}`,
      source: ".clerk/keyless.json",
    };
  }

  return undefined;
}

/**
 * Enriches the claim link with the instance's own id/environment, purely for
 * display. BAPI has no route that returns claim info for an existing
 * instance (only the one-time creation response does), so this can only ever
 * decorate a destination already found on disk — never produce one itself.
 * Failures here must not block opening the claim link, hence the catch.
 */
export async function describeKeylessInstance(secretKey: string): Promise<KeylessInstanceInfo> {
  try {
    const response = await bapiRequest({ method: "GET", path: "/v1/instance", secretKey });
    const body = response.body as { id?: string; environment_type?: string };
    return { instanceId: body.id ?? null, environmentType: body.environment_type ?? null };
  } catch (error) {
    log.debug(`open: could not fetch instance info for keyless app (${(error as Error).message})`);
    return { instanceId: null, environmentType: null };
  }
}
