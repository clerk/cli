import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getMode, setMode } from "../../../mode.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useCaptureLog, useMigrateLogDir } from "../../../test/lib/stubs.ts";
import { getLogDir } from "../lib/logger.ts";
import { setAssumeYes } from "../lib/assume-yes.ts";
import {
  buildIdentityReport,
  buildWorkOsExport,
  exportWorkOs,
  fetchAllWorkOsIdentities,
  fetchAllWorkOsUsers,
  fetchWorkOsIdentities,
  fetchWorkOsPage,
  mapWorkOsUserToExport,
  resolveWithIdentities,
  resolveWorkOsApiKey,
  type WorkOsIdentity,
} from "./workos.ts";

/** A cwd with no `.env` files, so these tests exercise only the injected env. */
const NO_ENV_FILES = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-no-env-"));

const captured = useCaptureLog();
useMigrateLogDir();

const API_KEY = "sk_test";

/** Colour is on or off depending on the runner, so rows are compared bare. */
const stripAnsi = (value: string): string => value.replace(/\u001b\[[0-9;]*m/g, "");

let workDir: string;
let originalCwd: string;
let originalFetch: typeof globalThis.fetch;
let requests: string[];

beforeAll(() => {
  originalCwd = process.cwd();
  originalFetch = globalThis.fetch;
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-expworkos-")));
  process.chdir(workDir);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Tests that need a prompt set human mode themselves; without this a leaked
  // "human" from an earlier test stops a later one on the destination prompt.
  setMode("agent");
  requests = [];
  fs.rmSync(getLogDir(), { recursive: true, force: true });
  fs.rmSync(path.join(workDir, "exports"), { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const workosUser = (i: number, overrides: Record<string, unknown> = {}) => ({
  id: `user_0${i}`,
  email: `a${i}@x.dev`,
  email_verified: true,
  first_name: `Given${i}`,
  last_name: `Family${i}`,
  ...overrides,
});

/**
 * Stubs one users page per entry in `pages`, chaining the cursor, plus an
 * identities response per user id in `identities`.
 */
function stubWorkOs(
  pages: Record<string, unknown>[][],
  identities: Record<string, WorkOsIdentity[] | "fail"> = {},
) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input.toString();
    requests.push(url);

    const identityMatch = /\/users\/([^/]+)\/identities/.exec(url);
    if (identityMatch) {
      const entry = identities[identityMatch[1] as string];
      if (entry === "fail") return new Response("nope", { status: 500 });
      return Response.json(entry ?? []);
    }

    const after = new URL(url).searchParams.get("after");
    const index = after ? Number(after.replace("cursor", "")) : 0;
    const isLast = index >= pages.length - 1;
    return Response.json({
      data: pages[index] ?? [],
      list_metadata: { after: isLast ? null : `cursor${index + 1}` },
    });
  }) as unknown as typeof fetch;
}

describe("resolveWorkOsApiKey", () => {
  test("prefers the flag", async () => {
    expect(await resolveWorkOsApiKey({ apiKey: "sk_flag" }, NO_ENV_FILES, {})).toBe("sk_flag");
  });

  test("falls back to the environment", async () => {
    expect(await resolveWorkOsApiKey({}, NO_ENV_FILES, { WORKOS_API_KEY: "sk_env" })).toBe(
      "sk_env",
    );
  });

  // Tests run non-TTY, the same signal an agent gives.
  test("names the flag and the variable when neither supplied one", async () => {
    await expect(resolveWorkOsApiKey({}, NO_ENV_FILES, {})).rejects.toThrow(
      /Missing: --api-key \(or WORKOS_API_KEY\)\./,
    );
  });
});

describe("fetchWorkOsPage", () => {
  test("asks for the documented page size", async () => {
    stubWorkOs([[]]);
    await fetchWorkOsPage(API_KEY);
    expect(requests[0]).toContain("limit=100");
  });

  test("explains a rejection instead of surfacing a raw status", async () => {
    globalThis.fetch = (async () =>
      Response.json({ message: "Unauthorized" }, { status: 401 })) as unknown as typeof fetch;

    await expect(fetchWorkOsPage(API_KEY)).rejects.toThrow(
      /WorkOS returned 401 listing users: Unauthorized/,
    );
  });

  // The usual cause is a publishable key, or a key from the other environment.
  test("points at the key itself", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    await expect(fetchWorkOsPage(API_KEY)).rejects.toThrow(/secret key/);
  });
});

describe("fetchAllWorkOsUsers", () => {
  test("follows the cursor until it comes back null", async () => {
    stubWorkOs([
      Array.from({ length: 100 }, (_, i) => workosUser(i)),
      Array.from({ length: 4 }, (_, i) => workosUser(100 + i)),
    ]);

    const all = await fetchAllWorkOsUsers({ apiKey: API_KEY });

    expect(all).toHaveLength(104);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("after=cursor1");
  });

  // Cursor pagination has no record ceiling, so a full page that happens to be
  // the last one must not read as "there is more".
  test("stops on a full final page", async () => {
    stubWorkOs([Array.from({ length: 100 }, (_, i) => workosUser(i))]);
    expect(await fetchAllWorkOsUsers({ apiKey: API_KEY })).toHaveLength(100);
    expect(requests).toHaveLength(1);
  });

  test("reuses a page already fetched rather than asking twice", async () => {
    stubWorkOs([[workosUser(0)]]);
    const firstPage = await fetchWorkOsPage(API_KEY);
    requests = [];

    expect(await fetchAllWorkOsUsers({ apiKey: API_KEY, firstPage })).toHaveLength(1);
    expect(requests).toHaveLength(0);
  });
});

describe("resolveWithIdentities", () => {
  test("is on when the flag asked for it", async () => {
    expect(await resolveWithIdentities({ withIdentities: true }, 10)).toBe(true);
  });

  // The fan-out is one request per user and nothing it returns can be
  // imported, so it is never the default.
  test("is off without the flag when there is nobody to ask", async () => {
    expect(await resolveWithIdentities({}, 10)).toBe(false);
  });

  test("is off when `--no-with-identities` said so, even under -y", async () => {
    setAssumeYes(true);
    try {
      expect(await resolveWithIdentities({ withIdentities: false }, 10)).toBe(false);
    } finally {
      setAssumeYes(false);
    }
  });

  // `-y` is "answer the prompts yes", and the prompt is "also fetch providers?".
  test("is on under -y, which answers the question rather than asking it", async () => {
    const originalMode = getMode();
    setMode("human");
    setAssumeYes(true);
    try {
      expect(await resolveWithIdentities({}, 10)).toBe(true);
    } finally {
      setAssumeYes(false);
      setMode(originalMode);
    }
  });

  test("does not ask when there are no users to ask about", async () => {
    const originalMode = getMode();
    setMode("human");
    try {
      expect(await resolveWithIdentities({}, 0)).toBe(false);
    } finally {
      setMode(originalMode);
    }
  });
});

describe("fetchAllWorkOsIdentities", () => {
  test("collects each user's providers", async () => {
    stubWorkOs([[]], {
      user_00: [{ provider: "GoogleOAuth", idp_id: "g1", type: "OAuth" }],
      user_01: [],
    });

    const { identities, failed } = await fetchAllWorkOsIdentities({
      apiKey: API_KEY,
      users: [workosUser(0), workosUser(1)],
    });

    expect(identities.get("user_00")).toEqual([
      { provider: "GoogleOAuth", idp_id: "g1", type: "OAuth" },
    ]);
    expect(identities.get("user_01")).toEqual([]);
    expect(failed).toBe(0);
  });

  // "Lookup failed" and "has no providers" are different facts, and flattening
  // the first into the second would put a wrong number in the report.
  test("leaves a failed lookup absent rather than empty, and counts it", async () => {
    stubWorkOs([[]], { user_00: "fail", user_01: [] });

    const { identities, failed } = await fetchAllWorkOsIdentities({
      apiKey: API_KEY,
      users: [workosUser(0), workosUser(1)],
    });

    expect(identities.has("user_00")).toBe(false);
    expect(identities.get("user_01")).toEqual([]);
    expect(failed).toBe(1);
  });
});

describe("buildIdentityReport", () => {
  const rowsOf = (section: { rows: string[] }) =>
    section.rows.map((row) => stripAnsi(row).trimEnd());

  test("ranks providers by use, and counts users with none", () => {
    const section = buildIdentityReport(
      [workosUser(0), workosUser(1), workosUser(2), workosUser(3)],
      new Map([
        ["user_00", [{ provider: "GoogleOAuth" }]],
        ["user_01", [{ provider: "GoogleOAuth" }, { provider: "MicrosoftOAuth" }]],
        ["user_02", []],
        ["user_03", []],
      ]),
      0,
    );

    expect(section.title).toBe("OAuth providers");
    expect(rowsOf(section)).toEqual([
      "  GoogleOAuth        2 users",
      "  MicrosoftOAuth     1 user",
      "  no OAuth provider  2 users",
    ]);
  });

  // Counting a failed lookup as "no provider" would understate social sign-in.
  test("reports unreadable lookups on their own row, with the caveat", () => {
    const section = buildIdentityReport(
      [workosUser(0), workosUser(1)],
      new Map([["user_01", []]]),
      1,
    );

    const rows = rowsOf(section);
    expect(rows).toContain("  not readable       1 user");
    expect(rows).toContain("  no OAuth provider  1 user");
    expect(rows.at(-1)).toContain("no `identities` field in the export, rather than an empty one");
  });

  test("says nothing about unreadable lookups when there were none", () => {
    const section = buildIdentityReport([workosUser(0)], new Map([["user_00", []]]), 0);
    expect(rowsOf(section)).toEqual(["  no OAuth provider  1 user"]);
  });
});

describe("mapWorkOsUserToExport", () => {
  test("keeps the fields the workos transformer maps from", () => {
    expect(mapWorkOsUserToExport(workosUser(0, { created_at: "2025-01-01" }))).toEqual({
      id: "user_00",
      email: "a0@x.dev",
      first_name: "Given0",
      last_name: "Family0",
      created_at: "2025-01-01",
      email_verified: true,
    });
  });

  // Dropping a false flag would import an unconfirmed address as verified.
  test("keeps email_verified when it is false", () => {
    expect(mapWorkOsUserToExport(workosUser(0, { email_verified: false })).email_verified).toBe(
      false,
    );
  });

  test("drops tenant fields the import has no use for", () => {
    const mapped = mapWorkOsUserToExport(
      workosUser(0, {
        locale: "en-GB",
        profile_picture_url: "https://x.dev/a.png",
        last_sign_in_at: "2026-01-01",
        updated_at: "2026-01-01",
        external_id: "cust_1",
      }),
    );
    for (const noise of [
      "locale",
      "profile_picture_url",
      "last_sign_in_at",
      "updated_at",
      "external_id",
    ]) {
      expect(noise in mapped).toBe(false);
    }
  });

  test("omits empty metadata", () => {
    expect("metadata" in mapWorkOsUserToExport(workosUser(0, { metadata: {} }))).toBe(false);
    expect(mapWorkOsUserToExport(workosUser(0, { metadata: { plan: "pro" } })).metadata).toEqual({
      plan: "pro",
    });
  });

  test("carries identities only when they were fetched", () => {
    expect("identities" in mapWorkOsUserToExport(workosUser(0))).toBe(false);
    expect(mapWorkOsUserToExport(workosUser(0), [{ provider: "GoogleOAuth" }]).identities).toEqual([
      { provider: "GoogleOAuth" },
    ]);
  });
});

describe("buildWorkOsExport", () => {
  test("counts coverage and logs each user", () => {
    const { users, coverage } = buildWorkOsExport(
      [workosUser(0), workosUser(1, { first_name: undefined })],
      "2026-01-01T00:00:00",
    );

    expect(users).toHaveLength(2);
    const byLabel = Object.fromEntries(coverage.map((c) => [c.label, c.count]));
    expect(byLabel["have an email address"]).toBe(2);
    expect(byLabel["have a first name"]).toBe(1);

    const logged = fs.readdirSync(getLogDir());
    expect(logged[0]).toMatch(/^export-/);
  });

  // Always shown, always zero: seeing it before the import is the point.
  test("reports the password row even though it can only ever be zero", () => {
    const { coverage } = buildWorkOsExport([workosUser(0)], "2026-01-01T00:00:00");
    expect(coverage.at(-1)).toEqual({
      label: "have a password (WorkOS returns none)",
      count: 0,
    });
  });

  // Providers get their own block: a coverage row means "N of M users have
  // this field", and a provider count can exceed M.
  test("keeps providers out of the coverage table", () => {
    const { coverage } = buildWorkOsExport(
      [workosUser(0)],
      "2026-01-01T00:00:00",
      new Map([["user_00", [{ provider: "GoogleOAuth" }]]]),
    );
    expect(coverage.some((row) => row.label.toLowerCase().includes("oauth"))).toBe(false);
  });
});

/** The one file the export just wrote into `exports/`, whatever it stamped it. */
function onlyExportFile(): string {
  const entries = fs.readdirSync(path.join(workDir, "exports"));
  expect(entries).toHaveLength(1);
  return path.join(workDir, "exports", entries[0] as string);
}

describe("exportWorkOs", () => {
  test("writes the default path and reports coverage", async () => {
    stubWorkOs([[workosUser(0)]]);

    await exportWorkOs({ apiKey: API_KEY });

    // Stamped to the minute, so a second export does not overwrite the first.
    expect(path.basename(onlyExportFile())).toMatch(/^workos-export-\d{8}-\d{4}\.json$/);
    const written = JSON.parse(fs.readFileSync(onlyExportFile(), "utf-8")) as Record<
      string,
      unknown
    >[];
    expect(written[0]?.id).toBe("user_00");
    expect(captured.err).toContain("Field coverage");
  });

  test("names the command that consumes the file", async () => {
    stubWorkOs([[workosUser(0)]]);
    // The suggestion rides the gutter's Next steps block, which only renders
    // in human mode.
    const originalMode = getMode();
    setMode("human");
    try {
      // --output answers the destination prompt, and --with-identities answers
      // the providers question, so human mode stops on neither.
      await exportWorkOs({ apiKey: API_KEY, output: "exports/mine.json", withIdentities: true });
    } finally {
      setMode(originalMode);
    }
    expect(captured.err).toContain("migrate import --transformer workos --file exports/mine.json");
  });

  test("--output controls the destination", async () => {
    stubWorkOs([[workosUser(0)]]);

    await exportWorkOs({ apiKey: API_KEY, output: "tenant.json" });

    expect(fs.existsSync(path.join(workDir, "tenant.json"))).toBe(true);
  });

  test("skips the per-user identity fan-out unless asked", async () => {
    stubWorkOs([[workosUser(0), workosUser(1)]]);

    await exportWorkOs({ apiKey: API_KEY, output: "plain.json" });

    expect(requests.filter((url) => url.includes("/identities"))).toHaveLength(0);
  });

  test("--with-identities records each user's providers in the file", async () => {
    stubWorkOs([[workosUser(0)]], { user_00: [{ provider: "GoogleOAuth", idp_id: "g1" }] });

    await exportWorkOs({ apiKey: API_KEY, output: "rich.json", withIdentities: true });

    const written = JSON.parse(fs.readFileSync(path.join(workDir, "rich.json"), "utf-8")) as Record<
      string,
      unknown
    >[];
    expect(written[0]?.identities).toEqual([{ provider: "GoogleOAuth", idp_id: "g1" }]);
  });

  // Finding this out after the import means nobody can sign in.
  test("says plainly that no credentials are in the file", async () => {
    stubWorkOs([[workosUser(0)]]);
    await exportWorkOs({ apiKey: API_KEY, output: "warned.json" });
    expect(captured.err).toContain("does not return password hashes or TOTP secrets");
  });
});

describe("fetchWorkOsIdentities", () => {
  test("accepts the bare array the endpoint returns", async () => {
    stubWorkOs([[]], { user_00: [{ provider: "GoogleOAuth" }] });
    expect(await fetchWorkOsIdentities(API_KEY, "user_00")).toEqual([{ provider: "GoogleOAuth" }]);
  });

  // A move to WorkOS's usual envelope must not read as "no providers".
  test("accepts a { data } envelope too", async () => {
    globalThis.fetch = (async () =>
      Response.json({ data: [{ provider: "AppleOAuth" }] })) as unknown as typeof fetch;
    expect(await fetchWorkOsIdentities(API_KEY, "user_00")).toEqual([{ provider: "AppleOAuth" }]);
  });
});
