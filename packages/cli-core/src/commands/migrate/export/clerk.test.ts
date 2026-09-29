import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getMode, setMode } from "../../../mode.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { getLogDir } from "../lib/logger.ts";
import {
  buildClerkExport,
  exportClerk,
  fetchAllClerkUsers,
  mapClerkUserToExport,
} from "./clerk.ts";

const captured = useCaptureLog();

let workDir: string;
let originalCwd: string;
let originalFetch: typeof globalThis.fetch;
let requests: string[];

beforeAll(() => {
  originalCwd = process.cwd();
  originalFetch = globalThis.fetch;
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-expclerk-")));
  process.chdir(workDir);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Tests that need a prompt set human mode themselves; without this a
  // leaked "human" from an earlier test stops a later one on the destination prompt.
  setMode("agent");
  requests = [];
  fs.rmSync(getLogDir(), { recursive: true, force: true });
  fs.rmSync(path.join(workDir, "exports"), { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Answers `GET /v1/users` from `pages`, one page per call. */
function stubPages(pages: unknown[][]) {
  let call = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(input.toString());
    return Response.json(pages[call++] ?? []);
  }) as unknown as typeof fetch;
}

const user = (overrides: Record<string, unknown> = {}) => ({
  id: "user_1",
  primary_email_address_id: "idn_1",
  email_addresses: [
    { id: "idn_1", email_address: "a@x.dev", verification: { status: "verified" } },
  ],
  phone_numbers: [],
  ...overrides,
});

describe("mapClerkUserToExport", () => {
  test("writes the field names the clerk transformer reads", () => {
    expect(
      mapClerkUserToExport(user({ first_name: "Ada", last_name: "L", username: "ada" })),
    ).toMatchObject({
      id: "user_1",
      primary_email_address: "a@x.dev",
      first_name: "Ada",
      last_name: "L",
      username: "ada",
    });
  });

  // `migrate import` puts the first entry on POST /v1/users and attaches the rest
  // afterwards, so a reordered list would change which address signs the user in.
  test("keeps the primary identifier out of the additional list", () => {
    const mapped = mapClerkUserToExport(
      user({
        email_addresses: [
          { id: "idn_1", email_address: "a@x.dev", verification: { status: "verified" } },
          { id: "idn_2", email_address: "b@x.dev", verification: { status: "verified" } },
        ],
      }),
    );
    expect(mapped.primary_email_address).toBe("a@x.dev");
    expect(mapped.verified_email_addresses).toEqual(["b@x.dev"]);
  });

  test("separates unverified identifiers", () => {
    const mapped = mapClerkUserToExport(
      user({
        email_addresses: [
          { id: "idn_1", email_address: "a@x.dev", verification: { status: "verified" } },
          { id: "idn_2", email_address: "c@x.dev", verification: { status: "unverified" } },
        ],
      }),
    );
    expect(mapped.unverified_email_addresses).toEqual(["c@x.dev"]);
    expect(mapped.verified_email_addresses).toBeUndefined();
  });

  test("promotes the first verified address when none is flagged primary", () => {
    const mapped = mapClerkUserToExport(
      user({
        primary_email_address_id: null,
        email_addresses: [
          { id: "idn_1", email_address: "a@x.dev", verification: { status: "verified" } },
          { id: "idn_2", email_address: "b@x.dev", verification: { status: "verified" } },
        ],
      }),
    );
    expect(mapped.primary_email_address).toBe("a@x.dev");
    expect(mapped.verified_email_addresses).toEqual(["b@x.dev"]);
  });

  test("maps phone numbers the same way", () => {
    const mapped = mapClerkUserToExport(
      user({
        primary_phone_number_id: "pn_1",
        phone_numbers: [
          { id: "pn_1", phone_number: "+15555550100", verification: { status: "verified" } },
          { id: "pn_2", phone_number: "+15555550101", verification: { status: "unverified" } },
        ],
      }),
    );
    expect(mapped.primary_phone_number).toBe("+15555550100");
    expect(mapped.unverified_phone_numbers).toEqual(["+15555550101"]);
  });

  test("converts BAPI's Unix-millisecond timestamps to RFC3339", () => {
    const mapped = mapClerkUserToExport(user({ created_at: 1704067200000 }));
    expect(mapped.created_at).toBe("2024-01-01T00:00:00.000Z");
  });

  test("omits empty metadata rather than writing empty objects", () => {
    const mapped = mapClerkUserToExport(
      user({ public_metadata: {}, private_metadata: { plan: "pro" } }),
    );
    expect("public_metadata" in mapped).toBe(false);
    expect(mapped.private_metadata).toEqual({ plan: "pro" });
  });

  test("carries the account-state fields the import accepts", () => {
    const mapped = mapClerkUserToExport(
      user({
        banned: true,
        create_organization_enabled: false,
        create_organizations_limit: 3,
        delete_self_enabled: true,
      }),
    );
    expect(mapped).toMatchObject({
      banned: true,
      create_organization_enabled: false,
      create_organizations_limit: 3,
      delete_self_enabled: true,
    });
  });
});

describe("fetchAllClerkUsers", () => {
  test("pages until a short page arrives", async () => {
    stubPages([
      Array.from({ length: 500 }, (_, i) => user({ id: `u${i}` })),
      Array.from({ length: 12 }, (_, i) => user({ id: `v${i}` })),
    ]);

    const all = await fetchAllClerkUsers({ secretKey: "sk_test_x" });

    expect(all).toHaveLength(512);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("offset=500");
  });

  // A full final page must still trigger one more request, or an instance whose
  // size is an exact multiple of the page size would look short by one page.
  test("makes one more request when the last page is exactly full", async () => {
    stubPages([Array.from({ length: 500 }, (_, i) => user({ id: `u${i}` })), []]);

    const all = await fetchAllClerkUsers({ secretKey: "sk_test_x" });

    expect(all).toHaveLength(500);
    expect(requests).toHaveLength(2);
  });

  test("asks for BAPI's maximum page size", async () => {
    stubPages([[]]);
    await fetchAllClerkUsers({ secretKey: "sk_test_x" });
    expect(requests[0]).toContain("limit=500");
  });

  test("copes with an instance that has no users", async () => {
    stubPages([[]]);
    expect(await fetchAllClerkUsers({ secretKey: "sk_test_x" })).toEqual([]);
  });
});

describe("buildClerkExport", () => {
  test("counts coverage per field", () => {
    const { coverage } = buildClerkExport(
      [user({ id: "u1", first_name: "Ada", password_enabled: true }), user({ id: "u2" })],
      "2026-01-01T00:00:00",
    );

    const byLabel = Object.fromEntries(coverage.map((c) => [c.label, c.count]));
    expect(byLabel["have an email address"]).toBe(2);
    expect(byLabel["have a first name"]).toBe(1);
    expect(byLabel["have a password (not exportable — see below)"]).toBe(1);
  });

  test("logs one NDJSON line per exported user", () => {
    buildClerkExport([user({ id: "u1" }), user({ id: "u2" })], "2026-01-01T00:00:00");

    const entries = fs
      .readdirSync(getLogDir())
      .flatMap((name) => fs.readFileSync(path.join(getLogDir(), name), "utf-8").trim().split("\n"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ userId: "u1", status: "success" });
  });

  test("writes the export log where `logs list` will find it", () => {
    buildClerkExport([user()], "2026-01-01T12:00:00");
    expect(fs.readdirSync(getLogDir())[0]).toBe("export-2026-01-01T12-00-00.log");
  });
});

/** The one file the export just wrote into `exports/`, whatever it stamped it. */
function onlyExportFile(): string {
  const entries = fs.readdirSync(path.join(workDir, "exports"));
  expect(entries).toHaveLength(1);
  return path.join(workDir, "exports", entries[0] as string);
}

describe("exportClerk", () => {
  test("writes the default path and reports coverage", async () => {
    stubPages([[user({ id: "u1", first_name: "Ada" })], []]);

    await exportClerk({ secretKey: "sk_test_x" });

    // Stamped to the minute, so a second export does not overwrite the first.
    expect(path.basename(onlyExportFile())).toMatch(/^clerk-export-\d{8}-\d{4}\.json$/);
    const written = JSON.parse(fs.readFileSync(onlyExportFile(), "utf-8")) as Record<
      string,
      unknown
    >[];
    expect(written).toHaveLength(1);
    expect(written[0]?.id).toBe("u1");
    expect(captured.err).toContain("Field coverage");
    expect(captured.err).toContain("Exported 1 user");
  });

  test("names the command that consumes the file", async () => {
    stubPages([[user()], []]);
    // The suggestion now rides the gutter's Next steps block, which only
    // renders in human mode.
    const originalMode = getMode();
    setMode("human");
    try {
      // --output answers the destination prompt, which human mode would
      // otherwise stop on.
      await exportClerk({ secretKey: "sk_test_x", output: "exports/mine.json" });
    } finally {
      setMode(originalMode);
    }
    expect(captured.err).toContain("migrate import --transformer clerk --file exports/mine.json");
  });

  test("--output controls the destination, relative to the working directory", async () => {
    stubPages([[user()], []]);

    await exportClerk({ secretKey: "sk_test_x", output: "somewhere/mine.json" });

    expect(fs.existsSync(path.join(workDir, "somewhere", "mine.json"))).toBe(true);
    expect(fs.existsSync(path.join(workDir, "exports"))).toBe(false);
  });

  // Silence here would be the worst outcome: the operator finds out when
  // nobody can sign in to the destination instance.
  test("says plainly that passwords are not in the file", async () => {
    stubPages([[user({ password_enabled: true })], []]);
    await exportClerk({ secretKey: "sk_test_x" });
    expect(captured.err).toContain("never returns password digests");
  });

  test("writes an empty file and says so when the instance has no users", async () => {
    stubPages([[]]);

    await exportClerk({ secretKey: "sk_test_x" });

    expect(captured.err).toContain("No users found to export");
    expect(JSON.parse(fs.readFileSync(onlyExportFile(), "utf-8"))).toEqual([]);
  });

  test("an empty export warns but does not suggest importing it", async () => {
    stubPages([[]]);
    const originalMode = getMode();
    setMode("human");
    try {
      await exportClerk({ secretKey: "sk_test_x", output: "exports/mine.json" });
    } finally {
      setMode(originalMode);
    }

    expect(captured.err).toContain("No users found to export");
    expect(captured.err).not.toContain("Next steps");
    expect(captured.err).not.toContain("migrate --transformer");
  });

  test("agent mode suppresses the Next steps block", async () => {
    stubPages([[user()], []]);

    await exportClerk({ secretKey: "sk_test_x" });

    expect(captured.err).toContain("Exported 1 user");
    expect(captured.err).not.toContain("Next steps");
    expect(captured.err).not.toContain("migrate --transformer");
  });
});
