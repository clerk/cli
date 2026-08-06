import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BapiError } from "../../lib/errors.ts";
import {
  buildCreateUserBody,
  importUsers,
  normalizeErrorMessage,
  readRetryAfter,
  splitIdentifiers,
} from "./import-users.ts";
import { getLogFilePath } from "./lib/logger.ts";
import type { ResolvedLimits } from "./lib/instance.ts";
import type { User } from "./types.ts";

const LIMITS: ResolvedLimits = { instanceType: "dev", rateLimit: 10_000, concurrencyLimit: 8 };
const DATE_TIME = "2026-01-01T00:00:00";

const user = (overrides: Partial<User> = {}): User =>
  ({ userId: "u1", email: "a@x.dev", ...overrides }) as User;

describe("splitIdentifiers", () => {
  test("promotes the first verified email and phone to primary", () => {
    const result = splitIdentifiers(
      user({ email: ["a@x.dev", "b@x.dev"], phone: ["+15555550100", "+15555550101"] }),
    );
    expect(result.primaryEmail).toBe("a@x.dev");
    expect(result.additionalEmails).toEqual(["b@x.dev"]);
    expect(result.primaryPhone).toBe("+15555550100");
    expect(result.additionalPhones).toEqual(["+15555550101"]);
  });

  test("merges the email and emailAddresses fields, deduping", () => {
    const result = splitIdentifiers(
      user({ email: "a@x.dev", emailAddresses: ["a@x.dev", "b@x.dev"] }),
    );
    expect(result.primaryEmail).toBe("a@x.dev");
    expect(result.additionalEmails).toEqual(["b@x.dev"]);
  });

  test("drops an unverified identifier that is already verified", () => {
    const result = splitIdentifiers(
      user({ email: ["a@x.dev"], unverifiedEmailAddresses: ["a@x.dev", "c@x.dev"] }),
    );
    expect(result.unverifiedEmails).toEqual(["c@x.dev"]);
  });

  test("copes with a user identified only by username", () => {
    const result = splitIdentifiers({ userId: "u1", username: "alice" } as User);
    expect(result.primaryEmail).toBeUndefined();
    expect(result.additionalEmails).toEqual([]);
  });
});

describe("buildCreateUserBody", () => {
  test("maps the schema onto BAPI's snake_case body", () => {
    const target = user({
      firstName: "Alice",
      lastName: "Smith",
      username: "alice",
      createdAt: "2024-01-01T00:00:00.000Z",
      publicMetadata: { plan: "pro" },
      createOrganizationsLimit: 3,
      banned: true,
    });
    const body = buildCreateUserBody(target, splitIdentifiers(target), true);

    expect(body).toMatchObject({
      external_id: "u1",
      email_address: ["a@x.dev"],
      first_name: "Alice",
      last_name: "Smith",
      username: "alice",
      created_at: "2024-01-01T00:00:00.000Z",
      public_metadata: { plan: "pro" },
      create_organizations_limit: 3,
      banned: true,
    });
  });

  test("sends only the primary identifier; the rest are attached separately", () => {
    const target = user({ email: ["a@x.dev", "b@x.dev"] });
    expect(buildCreateUserBody(target, splitIdentifiers(target), true).email_address).toEqual([
      "a@x.dev",
    ]);
  });

  test("omits fields the source platform never recorded", () => {
    const body = buildCreateUserBody(user(), splitIdentifiers(user()), true);
    expect("first_name" in body).toBe(false);
    expect("banned" in body).toBe(false);
    expect("created_at" in body).toBe(false);
  });

  test("sends the password digest and hasher together", () => {
    const target = user({ password: "digest", passwordHasher: "bcrypt" });
    const body = buildCreateUserBody(target, splitIdentifiers(target), true);
    expect(body).toMatchObject({ password_digest: "digest", password_hasher: "bcrypt" });
    expect("skip_password_requirement" in body).toBe(false);
  });

  test.each([
    [true, true],
    [false, false],
  ])("skipPasswordRequirement=%p on a passwordless user -> flag present: %p", (skip, present) => {
    const body = buildCreateUserBody(user(), splitIdentifiers(user()), skip);
    expect("skip_password_requirement" in body).toBe(present);
  });
});

describe("readRetryAfter", () => {
  const withHeader = (value: string) =>
    new BapiError(429, "{}", new Headers({ "retry-after": value }));

  test.each([
    ["12", 12],
    ["0", undefined],
    ["soon", undefined],
  ])("Retry-After: %s -> %p", (header, expected) => {
    expect(readRetryAfter(withHeader(header))).toBe(expected as number | undefined);
  });

  test("falls back to the error body's retryAfter meta", () => {
    const error = new BapiError(
      429,
      JSON.stringify({
        errors: [{ code: "rate_limit", message: "slow down", meta: { retryAfter: 7 } }],
      }),
      new Headers(),
    );
    expect(readRetryAfter(error)).toBe(7);
  });

  test("returns undefined when neither source carries a value", () => {
    expect(readRetryAfter(new BapiError(429, "{}", new Headers()))).toBeUndefined();
  });
});

describe("normalizeErrorMessage", () => {
  test("sorts field arrays so equivalent errors group together", () => {
    const a = normalizeErrorMessage('["last_name" "first_name"] data does not match');
    const b = normalizeErrorMessage('["first_name" "last_name"] data does not match');
    expect(a).toBe(b);
    expect(a).toBe('["first_name" "last_name"] data does not match');
  });

  test("leaves messages without field arrays untouched", () => {
    expect(normalizeErrorMessage("that email is taken")).toBe("that email is taken");
  });
});

describe("importUsers", () => {
  let workDir: string;
  let originalCwd: string;
  let originalFetch: typeof globalThis.fetch;
  let requests: { method: string; url: string; body: unknown }[];

  beforeAll(() => {
    originalCwd = process.cwd();
    originalFetch = globalThis.fetch;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-import-"));
    process.chdir(workDir);
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    requests = [];
    fs.rmSync(path.join(workDir, "logs"), { recursive: true, force: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Installs a fetch that records every request and replies per `respond`. */
  function stub(respond: (url: string, attempt: number) => Response): void {
    const attempts = new Map<string, number>();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      requests.push({
        method: init?.method ?? "GET",
        url,
        body: init?.body ? JSON.parse(init.body as string) : null,
      });
      const attempt = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, attempt);
      return respond(url, attempt);
    }) as typeof fetch;
  }

  const ok = (id: string) => new Response(JSON.stringify({ id }), { status: 200 });

  const clerkError = (status: number, message: string, headers?: Record<string, string>) =>
    new Response(JSON.stringify({ errors: [{ code: "err", message, long_message: message }] }), {
      status,
      headers,
    });

  const logEntries = () =>
    fs
      .readFileSync(getLogFilePath("migration", DATE_TIME), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  test("creates each user and reports them as successful", async () => {
    stub(() => ok("user_created"));

    const summary = await importUsers({
      users: [user({ userId: "u1" }), user({ userId: "u2", email: "b@x.dev" })],
      secretKey: "sk_test_x",
      limits: LIMITS,
      dateTime: DATE_TIME,
    });

    expect(summary).toMatchObject({ totalProcessed: 2, successful: 2, failed: 0 });
    expect(requests.filter((r) => r.url.endsWith("/v1/users"))).toHaveLength(2);
    expect(logEntries().filter((e) => e.status === "success")).toHaveLength(2);
  });

  test("attaches additional and unverified identifiers after the user exists", async () => {
    stub(() => ok("user_created"));

    await importUsers({
      users: [
        user({
          email: ["a@x.dev", "b@x.dev"],
          unverifiedEmailAddresses: ["c@x.dev"],
          phone: ["+15555550100", "+15555550101"],
        }),
      ],
      secretKey: "sk_test_x",
      limits: LIMITS,
      dateTime: DATE_TIME,
    });

    const emails = requests.filter((r) => r.url.endsWith("/v1/email_addresses"));
    expect(emails.map((r) => r.body)).toEqual([
      { user_id: "user_created", email_address: "b@x.dev", primary: false, verified: true },
      { user_id: "user_created", email_address: "c@x.dev", primary: false, verified: false },
    ]);
    expect(requests.filter((r) => r.url.endsWith("/v1/phone_numbers"))).toHaveLength(1);
  });

  test("logs a failed additional identifier without failing the user", async () => {
    stub((url) =>
      url.endsWith("/v1/email_addresses")
        ? clerkError(422, "that email is taken")
        : ok("user_created"),
    );

    const summary = await importUsers({
      users: [user({ email: ["a@x.dev", "b@x.dev"] })],
      secretKey: "sk_test_x",
      limits: LIMITS,
      dateTime: DATE_TIME,
    });

    expect(summary).toMatchObject({ successful: 1, failed: 0 });
    expect(logEntries().some((e) => e.status === "additional_email_error")).toBe(true);
  });

  test("records a failed user and keeps going", async () => {
    stub((_url, attempt) =>
      attempt === 1 ? clerkError(422, "that email is taken") : ok("user_ok"),
    );

    const summary = await importUsers({
      users: [user({ userId: "u1" }), user({ userId: "u2", email: "b@x.dev" })],
      secretKey: "sk_test_x",
      limits: LIMITS,
      dateTime: DATE_TIME,
    });

    expect(summary.successful + summary.failed).toBe(2);
    expect(summary.failed).toBe(1);
    expect([...summary.errorBreakdown.values()]).toEqual([1]);
    expect(logEntries().some((e) => e.status === "error" && e.code === "422")).toBe(true);
  });

  test("retries a 429 after the interval the server asked for", async () => {
    stub((_url, attempt) =>
      attempt === 1 ? clerkError(429, "slow down", { "retry-after": "1" }) : ok("user_ok"),
    );

    const started = performance.now();
    const summary = await importUsers({
      users: [user()],
      secretKey: "sk_test_x",
      limits: LIMITS,
      dateTime: DATE_TIME,
    });

    expect(summary).toMatchObject({ successful: 1, failed: 0 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(900);
    expect(requests.filter((r) => r.url.endsWith("/v1/users"))).toHaveLength(2);
    expect(logEntries().some((e) => e.status === "429_retry")).toBe(true);
  });

  test("gives up after the retry ceiling and records the user as failed", async () => {
    stub(() => clerkError(429, "slow down", { "retry-after": "1" }));

    const summary = await importUsers({
      users: [user()],
      secretKey: "sk_test_x",
      limits: LIMITS,
      dateTime: DATE_TIME,
    });

    expect(summary).toMatchObject({ successful: 0, failed: 1 });
    // One initial attempt plus MAX_RETRIES retries.
    expect(requests.filter((r) => r.url.endsWith("/v1/users"))).toHaveLength(6);
    expect(logEntries().some((e) => e.code === "429")).toBe(true);
  }, 20_000);

  test("carries the validation failure count into the summary", async () => {
    stub(() => ok("user_ok"));

    const summary = await importUsers({
      users: [user()],
      secretKey: "sk_test_x",
      limits: LIMITS,
      dateTime: DATE_TIME,
      validationFailed: 4,
    });

    expect(summary.validationFailed).toBe(4);
  });
});
