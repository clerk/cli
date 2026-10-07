import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, EXIT_CODE } from "../../../lib/errors.ts";
import type { UserLine } from "../lib/run-store.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import {
  buildAuth0Export,
  exportAuth0,
  fetchAllAuth0Users,
  fetchAuth0Token,
  mapAuth0UserToExport,
  isAuth0Domain,
  normalizeAuth0Domain,
  resolveAuth0Credentials,
} from "./auth0.ts";

const captured = useCaptureLog();

const CREDENTIALS = { domain: "t.auth0.com", clientId: "cid", clientSecret: "csec" };

let workDir: string;
let originalCwd: string;
let originalFetch: typeof globalThis.fetch;
let requests: { url: string; body: unknown }[];

let originalMode: string | undefined;

beforeAll(() => {
  originalMode = process.env.CLERK_MODE;
  originalCwd = process.cwd();
  originalFetch = globalThis.fetch;
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-expauth0-")));
  process.chdir(workDir);
});

afterAll(() => {
  if (originalMode === undefined) delete process.env.CLERK_MODE;
  else process.env.CLERK_MODE = originalMode;
  globalThis.fetch = originalFetch;
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Tests that need a prompt set human mode themselves; without this a
  // leaked "human" from an earlier test stops a later one on the destination prompt.
  process.env.CLERK_MODE = "agent";
  requests = [];
  fs.rmSync(path.join(workDir, ".clerk"), { recursive: true, force: true });
  fs.rmSync(path.join(workDir, "exports"), { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const auth0User = (i: number, overrides: Record<string, unknown> = {}) => ({
  user_id: `auth0|a${i}`,
  email: `a${i}@x.dev`,
  email_verified: true,
  given_name: `Given${i}`,
  family_name: `Family${i}`,
  ...overrides,
});

/** Stubs the token exchange plus one page of users per entry in `pages`. */
function stubAuth0(pages: Record<string, unknown>[][], token: Response | null = null) {
  let page = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    requests.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });

    if (url.includes("/oauth/token")) {
      return token ?? Response.json({ access_token: "tok" });
    }
    return Response.json({
      users: pages[page++] ?? [],
      total: pages.reduce((sum, p) => sum + p.length, 0),
    });
  }) as unknown as typeof fetch;
}

describe("normalizeAuth0Domain", () => {
  test.each([
    ["t.auth0.com", "t.auth0.com"],
    ["https://t.auth0.com", "t.auth0.com"],
    ["http://t.auth0.com/", "t.auth0.com"],
    ["  t.auth0.com  ", "t.auth0.com"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeAuth0Domain(input)).toBe(expected);
  });
});

// The client secret goes to this host, so anything that could make URL parsing
// pick a different one is refused.
describe("isAuth0Domain", () => {
  test.each(["t.auth0.com", "https://t.auth0.com/", "login.example.com"])(
    "accepts %s",
    (domain) => {
      expect(isAuth0Domain(domain)).toBe(true);
    },
  );

  test.each([
    "t.auth0.com@attacker.example",
    "t.auth0.com/path",
    "t.auth0.com:8443",
    "t.auth0.com?x=1",
    "localhost",
  ])("refuses %s", (domain) => {
    expect(isAuth0Domain(domain)).toBe(false);
  });
});

describe("resolveAuth0Credentials", () => {
  test("refuses a domain that would send the secret to another host", async () => {
    await expect(
      resolveAuth0Credentials(
        {},
        {
          AUTH0_DOMAIN: "t.auth0.com@attacker.example",
          AUTH0_CLIENT_ID: "c",
          AUTH0_CLIENT_SECRET: "s",
        },
      ),
    ).rejects.toThrow(/is not an Auth0 domain/);
  });

  test("prefers flags", async () => {
    const resolved = await resolveAuth0Credentials(
      { domain: "flag.auth0.com", clientId: "f", clientSecret: "s" },
      { AUTH0_DOMAIN: "env.auth0.com" },
    );
    expect(resolved.domain).toBe("flag.auth0.com");
  });

  test("falls back to the environment", async () => {
    const resolved = await resolveAuth0Credentials(
      {},
      {
        AUTH0_DOMAIN: "env.auth0.com",
        AUTH0_CLIENT_ID: "e",
        AUTH0_CLIENT_SECRET: "s",
      },
    );
    expect(resolved).toEqual({ domain: "env.auth0.com", clientId: "e", clientSecret: "s" });
  });

  test("normalizes a domain that came with a scheme", async () => {
    const resolved = await resolveAuth0Credentials(
      { domain: "https://t.auth0.com/", clientId: "c", clientSecret: "s" },
      {},
    );
    expect(resolved.domain).toBe("t.auth0.com");
  });

  // Tests run non-TTY, the same signal an agent gives.
  test("names every missing credential at once rather than one at a time", async () => {
    await expect(resolveAuth0Credentials({}, {})).rejects.toThrow(
      /--domain \(or AUTH0_DOMAIN\), --client-id \(or AUTH0_CLIENT_ID\), --client-secret \(or AUTH0_CLIENT_SECRET\)/,
    );
  });

  test("names only what is actually missing", async () => {
    await expect(
      resolveAuth0Credentials({ domain: "t.auth0.com", clientId: "c" }, {}),
    ).rejects.toThrow(/Missing: --client-secret \(or AUTH0_CLIENT_SECRET\)\./);
  });
});

describe("fetchAuth0Token", () => {
  test("exchanges client credentials for the Management API audience", async () => {
    stubAuth0([[]]);

    expect(await fetchAuth0Token(CREDENTIALS)).toBe("tok");
    expect(requests[0]?.url).toBe("https://t.auth0.com/oauth/token");
    expect(requests[0]?.body).toEqual({
      grant_type: "client_credentials",
      client_id: "cid",
      client_secret: "csec",
      audience: "https://t.auth0.com/api/v2/",
    });
  });

  test("explains a rejection instead of surfacing a raw status", async () => {
    stubAuth0(
      [[]],
      new Response(JSON.stringify({ error_description: "Wrong client secret" }), { status: 401 }),
    );

    await expect(fetchAuth0Token(CREDENTIALS)).rejects.toThrow(
      /Auth0 rejected the credentials \(401\): Wrong client secret/,
    );
  });

  // An outage is not a bad credential: no re-prompt, and exit 1, not 2.
  test("a 5xx is an outage, not a rejected credential", async () => {
    stubAuth0([[]], new Response("{}", { status: 503 }));
    const error = (await fetchAuth0Token(CREDENTIALS).catch((e: unknown) => e)) as CliError;
    expect(error.message).toContain("Auth0 did not issue a token (503)");
    expect(error.exitCode).not.toBe(EXIT_CODE.USAGE);
  });

  test("does not follow a redirect with the client secret", async () => {
    let redirect: RequestInit["redirect"];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      redirect = init?.redirect;
      return new Response(null, {
        status: 307,
        headers: { location: "https://elsewhere.example/" },
      });
    }) as unknown as typeof fetch;

    await expect(fetchAuth0Token(CREDENTIALS)).rejects.toThrow(/did not issue a token \(307\)/);
    expect(redirect).toBe("manual");
  });

  test("mentions the read:users scope, the usual cause", async () => {
    stubAuth0([[]], new Response("{}", { status: 403 }));
    await expect(fetchAuth0Token(CREDENTIALS)).rejects.toThrow(/read:users/);
  });

  test("fails when a 200 carries no token", async () => {
    stubAuth0([[]], Response.json({}));
    await expect(fetchAuth0Token(CREDENTIALS)).rejects.toThrow(CliError);
  });
});

describe("fetchAllAuth0Users", () => {
  test("pages until a short page arrives", async () => {
    stubAuth0([
      Array.from({ length: 100 }, (_, i) => auth0User(i)),
      Array.from({ length: 4 }, (_, i) => auth0User(100 + i)),
    ]);

    const { users: all, truncated } = await fetchAllAuth0Users({
      credentials: CREDENTIALS,
      token: "tok",
    });

    expect(all).toHaveLength(104);
    expect(truncated).toBe(false);
    expect(requests[0]?.url).toContain("page=0");
    expect(requests[1]?.url).toContain("page=1");
    expect(requests).toHaveLength(2);
  });

  test("asks for totals and the documented page size", async () => {
    stubAuth0([[]]);
    await fetchAllAuth0Users({ credentials: CREDENTIALS, token: "tok" });
    expect(requests[0]?.url).toContain("per_page=100");
    expect(requests[0]?.url).toContain("include_totals=true");
  });

  // Auth0 caps offset pagination at 1000. Returning the first thousand quietly
  // would read as "that is everyone".
  test("stops at Auth0's 1000-record ceiling and says so", async () => {
    stubAuth0(
      Array.from({ length: 12 }, () => Array.from({ length: 100 }, (_, i) => auth0User(i))),
    );

    const { users: all, truncated } = await fetchAllAuth0Users({
      credentials: CREDENTIALS,
      token: "tok",
    });

    expect(all).toHaveLength(1000);
    expect(truncated).toBe(true);
    expect(captured.err).toContain("only pages through the first 1000 users");
    expect(captured.err).toContain("bulk user export job");
  });

  test("a tenant of exactly 1000 users is complete, with no warning", async () => {
    stubAuth0(
      Array.from({ length: 10 }, () => Array.from({ length: 100 }, (_, i) => auth0User(i))),
    );

    const { users: all, truncated } = await fetchAllAuth0Users({
      credentials: CREDENTIALS,
      token: "tok",
    });

    expect(all).toHaveLength(1000);
    expect(truncated).toBe(false);
    expect(captured.err).not.toContain("only pages through");
  });

  test("does not follow a redirect with the bearer token", async () => {
    let redirect: RequestInit["redirect"];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      redirect = init?.redirect;
      return new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example/" },
      });
    }) as unknown as typeof fetch;

    await expect(fetchAllAuth0Users({ credentials: CREDENTIALS, token: "tok" })).rejects.toThrow(
      /Auth0 returned 302 listing users/,
    );
    expect(redirect).toBe("manual");
  });

  test("raises a clear error on a failed page request", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;

    await expect(fetchAllAuth0Users({ credentials: CREDENTIALS, token: "tok" })).rejects.toThrow(
      /Auth0 returned 500 listing users/,
    );
  });
});

describe("mapAuth0UserToExport", () => {
  test("keeps the fields the auth0 transformer maps from", () => {
    expect(
      mapAuth0UserToExport(auth0User(0, { phone_number: "+1555", created_at: "2025-01-01" })),
    ).toEqual({
      user_id: "auth0|a0",
      email: "a0@x.dev",
      given_name: "Given0",
      family_name: "Family0",
      phone_number: "+1555",
      created_at: "2025-01-01",
      email_verified: true,
    });
  });

  // Dropping a false flag would import an unconfirmed address as verified.
  test.each([
    ["email_verified", false],
    ["phone_verified", false],
  ])("keeps %s when it is %p", (field, value) => {
    const mapped = mapAuth0UserToExport(auth0User(0, { [field]: value }));
    expect(mapped[field]).toBe(value);
  });

  test("drops tenant internals the import has no use for", () => {
    const mapped = mapAuth0UserToExport(
      auth0User(0, {
        identities: [{ provider: "auth0" }],
        logins_count: 42,
        last_login: "2026-01-01",
        multifactor: ["guardian"],
      }),
    );
    for (const noise of ["identities", "logins_count", "last_login", "multifactor"]) {
      expect(noise in mapped).toBe(false);
    }
  });

  test("keeps blocked only when it is true", () => {
    expect(mapAuth0UserToExport(auth0User(0, { blocked: true })).blocked).toBe(true);
    expect("blocked" in mapAuth0UserToExport(auth0User(0, { blocked: false }))).toBe(false);
  });

  test("keeps name", () => {
    expect(mapAuth0UserToExport(auth0User(0, { name: "Ada Lovelace" })).name).toBe("Ada Lovelace");
  });

  test("omits empty metadata", () => {
    const mapped = mapAuth0UserToExport(
      auth0User(0, { user_metadata: {}, app_metadata: { plan: "pro" } }),
    );
    expect("user_metadata" in mapped).toBe(false);
    expect(mapped.app_metadata).toEqual({ plan: "pro" });
  });
});

describe("buildAuth0Export", () => {
  test("counts coverage and records each user", () => {
    const lines: UserLine[] = [];
    const { users, coverage } = buildAuth0Export(
      [auth0User(0), auth0User(1, { given_name: undefined })],
      (line) => lines.push(line),
    );

    expect(users).toHaveLength(2);
    const byLabel = Object.fromEntries(coverage.map((c) => [c.label, c.count]));
    expect(byLabel["have an email address"]).toBe(2);
    expect(byLabel["have a first name"]).toBe(1);

    expect(lines.map((line) => line.status)).toEqual(["exported", "exported"]);
  });
});

/** The envelope the one export run in this project wrote. */
function onlyExportFile(): string {
  const dir = path.join(workDir, ".clerk", "migrate");
  const entries = fs.readdirSync(dir);
  expect(entries).toHaveLength(1);
  return path.join(dir, entries[0] as string, "export.json");
}

/** The users inside that envelope. */
function exportedUsers(): Record<string, unknown>[] {
  return (
    JSON.parse(fs.readFileSync(onlyExportFile(), "utf-8")) as { users: Record<string, unknown>[] }
  ).users;
}

describe("exportAuth0", () => {
  test("writes the default path and reports coverage", async () => {
    stubAuth0([[auth0User(0)], []]);

    await exportAuth0({ ...CREDENTIALS });
    expect(JSON.parse(fs.readFileSync(onlyExportFile(), "utf-8"))).toMatchObject({
      source: "auth0",
    });
    const written = exportedUsers();
    expect(written[0]?.user_id).toBe("auth0|a0");
    expect(captured.err).toContain("Field coverage");
  });

  test("names the command that consumes the file", async () => {
    stubAuth0([[auth0User(0)], []]);
    // The suggestion now rides the gutter's Next steps block, which only
    // renders in human mode.
    process.env.CLERK_MODE = "human";
    await exportAuth0({ ...CREDENTIALS, output: "exports/mine.json" });
    expect(captured.err).toMatch(/clerk migrate import \d{8}-\d{6}-[0-9a-f]{4}/);
  });

  test("--output controls the destination", async () => {
    stubAuth0([[auth0User(0)], []]);

    await exportAuth0({ ...CREDENTIALS, output: "tenant.json" });

    expect(fs.existsSync(path.join(workDir, "tenant.json"))).toBe(true);
  });

  // Auth0 only releases hashes through a support request; finding that out
  // after the import means nobody can sign in.
  test("says plainly that password hashes are not in the file", async () => {
    stubAuth0([[auth0User(0)], []]);
    await exportAuth0({ ...CREDENTIALS });
    expect(captured.err).toContain("does not return password hashes");
  });
});
