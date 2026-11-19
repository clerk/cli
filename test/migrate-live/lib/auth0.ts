/**
 * Management API helpers shared by the Auth0 seeder and the Auth0 test
 * variations. Uses the web app's own client credentials (see seed-auth0.ts).
 *
 * The free tier allows ~2 requests/second, so every call retries on 429.
 */
const DOMAIN = () => process.env.AUTH0_DOMAIN!;

let cached: { token: string; expires: number } | undefined;

/** One token per process: Auth0's free plan caps M2M tokens at 1,000/month. */
export async function managementToken() {
  if (cached && cached.expires > Date.now()) return cached.token;
  const response = await fetch(`https://${DOMAIN()}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: process.env.AUTH0_CLIENT_ID,
      client_secret: process.env.AUTH0_CLIENT_SECRET,
      audience: `https://${DOMAIN()}/api/v2/`,
    }),
  });
  if (!response.ok)
    throw new Error(`Token request failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { access_token: string; expires_in: number };
  cached = { token: body.access_token, expires: Date.now() + (body.expires_in - 60) * 1000 };
  return cached.token;
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`https://${DOMAIN()}/api/v2${path}`, {
      ...init,
      headers: { authorization: `Bearer ${await managementToken()}`, ...init?.headers },
    });
    if (response.status === 429 && attempt < 8) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    if (!response.ok)
      throw Object.assign(
        new Error(`${init?.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`),
        {
          status: response.status,
        },
      );
    return response.status === 204 ? (undefined as T) : response.json();
  }
}

export const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Users in the tenant, up to Auth0's 1,000 ceiling on totals. */
export async function userCount() {
  return (await api<{ total: number }>("/users?per_page=1&include_totals=true&fields=user_id"))
    .total;
}

/**
 * GET /users reads a search index that lags writes and deletes by seconds, so
 * an export straight after a seed can miss users. Polls until the count lands.
 */
export async function waitForUserCount(expected: number, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await userCount();
    if (n === expected) return;
    if (Date.now() > deadline) throw new Error(`Auth0 lists ${n} users, expected ${expected}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
