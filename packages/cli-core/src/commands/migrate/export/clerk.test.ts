import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UserLine } from "../lib/run-store.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
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

let originalMode: string | undefined;

beforeAll(() => {
  originalMode = process.env.CLERK_MODE;
  originalCwd = process.cwd();
  originalFetch = globalThis.fetch;
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-expclerk-")));
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

/** Answers `GET /v1/users` from `pages`, one page per call. */
function stubPages(pages: unknown[][]) {
  let call = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    // The export names the instance it reads before paging through it.
    if (new URL(input.toString()).pathname === "/v1/instance") {
      return Response.json({ object: "instance", id: "ins_src", environment_type: "production" });
    }
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

  // Verify-at-sign-up off lets a primary stay unverified. Exported as primary,
  // the import would create it verified.
  test("keeps an unverified primary unverified, and promotes a verified one", () => {
    const mapped = mapClerkUserToExport(
      user({
        email_addresses: [
          { id: "idn_1", email_address: "a@x.dev", verification: { status: "unverified" } },
          { id: "idn_2", email_address: "b@x.dev", verification: { status: "verified" } },
        ],
      }),
    );
    expect(mapped.primary_email_address).toBe("b@x.dev");
    expect(mapped.unverified_email_addresses).toEqual(["a@x.dev"]);
  });

  // The import puts the old Clerk ID in external_id, so the app's own value
  // would otherwise be lost.
  test("moves external_id into private metadata, keeping what is there", () => {
    const mapped = mapClerkUserToExport(
      user({ external_id: "acct_9", private_metadata: { tier: "gold" } }),
    );
    expect(mapped.private_metadata).toEqual({ tier: "gold", clerkExternalId: "acct_9" });
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
    expect(requests[1]).toContain("offset=480");
  });

  // A user deleted after the first page shifts every later row back one. The
  // overlap re-reads the boundary, so the row that slid onto it isn't lost.
  test("keeps the user a mid-export deletion slides onto a page boundary", async () => {
    const users = Array.from({ length: 600 }, (_, i) => user({ id: `u${i}` }));
    let pages = 0;
    // A server that answers by offset, and loses u10 after the first page.
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      if (url.pathname === "/v1/instance") {
        return Response.json({ object: "instance", id: "ins_src", environment_type: "production" });
      }
      const offset = Number(url.searchParams.get("offset"));
      const rows = pages++ === 0 ? users : users.filter((entry) => entry.id !== "u10");
      return Response.json(rows.slice(offset, offset + 500));
    }) as unknown as typeof fetch;

    const all = await fetchAllClerkUsers({ secretKey: "sk_test_x" });

    expect(all.map((entry) => entry.id)).toContain("u500");
    expect(all).toHaveLength(600);
  });

  // Oldest first, so a sign-up mid-export lands at the end; a repeat the
  // overlap reads again is dropped.
  test("pages oldest first and drops a user a shifted page repeats", async () => {
    stubPages([
      Array.from({ length: 500 }, (_, i) => user({ id: `u${i}` })),
      [user({ id: "u499" }), user({ id: "v0" })],
    ]);

    const all = await fetchAllClerkUsers({ secretKey: "sk_test_x" });

    expect(all).toHaveLength(501);
    expect(requests[0]).toContain("order_by=%2Bcreated_at");
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
    const { coverage } = buildClerkExport([
      user({ id: "u1", first_name: "Ada", password_enabled: true }),
      user({ id: "u2" }),
    ]);

    const byLabel = Object.fromEntries(coverage.map((c) => [c.label, c.count]));
    expect(byLabel["have an email address"]).toBe(2);
    expect(byLabel["have a first name"]).toBe(1);
    expect(byLabel["have a password (not exportable — see below)"]).toBe(1);
  });

  test("records one line per exported user", () => {
    const lines: UserLine[] = [];
    buildClerkExport([user({ id: "u1" }), user({ id: "u2" })], (line) => lines.push(line));

    expect(lines).toEqual([
      { sourceId: "u1", status: "exported" },
      { sourceId: "u2", status: "exported" },
    ]);
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

describe("exportClerk", () => {
  test("writes the default path and reports coverage", async () => {
    stubPages([[user({ id: "u1", first_name: "Ada" })], []]);

    await exportClerk({ secretKey: "sk_test_x" });
    expect(JSON.parse(fs.readFileSync(onlyExportFile(), "utf-8"))).toMatchObject({
      source: "clerk",
    });
    const written = exportedUsers();
    expect(written).toHaveLength(1);
    expect(written[0]?.id).toBe("u1");
    expect(captured.err).toContain("Field coverage");
    expect(captured.err).toContain("Exported 1 user");
  });

  test("names the command that consumes the file", async () => {
    stubPages([[user()], []]);
    // The suggestion now rides the gutter's Next steps block, which only
    // renders in human mode.
    process.env.CLERK_MODE = "human";
    await exportClerk({ secretKey: "sk_test_x", output: "exports/mine.json" });
    expect(captured.err).toMatch(/clerk migrate import \d{8}-\d{6}-[0-9a-f]{4}/);
  });

  // The key decides the instance; --instance naming a different one would
  // label a read of one user pool with another's name.
  test("refuses an --instance the key does not address, before reading any user", async () => {
    stubPages([[user()], []]);

    await expect(exportClerk({ secretKey: "sk_test_x", instance: "dev" })).rejects.toThrow(
      /--instance dev does not match the key from --secret-key/,
    );
    expect(requests).toEqual([]);
  });

  test("names the instance it reads from first, and records it on the run", async () => {
    stubPages([[user()], []]);

    await exportClerk({ secretKey: "sk_test_x" });

    expect(Bun.stripANSI(captured.err)).toContain("Source: Clerk, production instance ins_src");
    expect(
      JSON.parse(fs.readFileSync(onlyExportFile().replace("export.json", "run.json"), "utf-8")),
    ).toMatchObject({
      target: {
        platform: "clerk",
        instanceId: "ins_src",
      },
    });
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
    expect(exportedUsers()).toEqual([]);
  });

  test("an empty export warns but does not suggest importing it", async () => {
    stubPages([[]]);
    process.env.CLERK_MODE = "human";
    await exportClerk({ secretKey: "sk_test_x", output: "exports/mine.json" });

    expect(captured.err).toContain("No users found to export");
    expect(captured.err).not.toContain("Next steps");
    expect(captured.err).not.toContain("Import them with");
  });

  test("agent mode suppresses the Next steps block", async () => {
    stubPages([[user()], []]);

    await exportClerk({ secretKey: "sk_test_x" });

    expect(captured.err).toContain("Exported 1 user");
    expect(captured.err).not.toContain("Next steps");
    // The import command still prints, where an agent can read it.
    expect(captured.err).toContain("Import them with");
  });
});
