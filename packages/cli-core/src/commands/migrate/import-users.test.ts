import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { BapiError } from "../../lib/errors.ts";
import { _resetInterruptState, abortInFlight } from "../../lib/signals.ts";
import {
  buildCreateUserBody,
  importUsers,
  normalizeErrorMessage,
  readRetryAfter,
  splitIdentifiers,
} from "./import-users.ts";
import type { ResolvedLimits } from "./lib/instance.ts";
import type { UserLine } from "./lib/run-store.ts";
import type { User } from "./types.ts";

const LIMITS: ResolvedLimits = { instanceType: "dev", rateLimit: 10_000, concurrencyLimit: 8 };

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

  // Allowlists and blocklists police sign-ups; these users already signed up.
  test("skips the instance's sign-up restrictions", () => {
    expect(buildCreateUserBody(user(), splitIdentifiers(user()), true)).toMatchObject({
      skip_restriction_checks: true,
    });
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
  let originalFetch: typeof globalThis.fetch;
  let requests: { method: string; url: string; body: unknown }[];
  let lines: UserLine[];
  let allLines: UserLine[];
  // `lines` leaves out the `creating` marker every user gets first; one test
  // below covers it through `allLines`.
  const record = (line: UserLine) => {
    allLines.push(line);
    if (line.status !== "creating") lines.push(line);
  };

  beforeAll(() => {
    originalFetch = globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    requests = [];
    lines = [];
    allLines = [];
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

  test("creates each user and reports them as successful", async () => {
    stub(() => ok("user_created"));

    const summary = await importUsers({
      users: [user({ userId: "u1" }), user({ userId: "u2", email: "b@x.dev" })],
      secretKey: "sk_test_x",
      limits: LIMITS,
      record,
    });

    expect(summary).toMatchObject({ totalProcessed: 2, successful: 2, failed: 0 });
    expect(requests.filter((r) => r.url.endsWith("/v1/users"))).toHaveLength(2);
    expect(lines.filter((line) => line.status === "created")).toHaveLength(2);
  });

  test("neither fails nor records a create a Ctrl-C stopped before it was sent", async () => {
    stub(() => ok("user_created"));
    abortInFlight();
    try {
      const summary = await importUsers({
        users: [user({ userId: "u1" }), user({ userId: "u2", email: "b@x.dev" })],
        secretKey: "sk_test_x",
        limits: LIMITS,
        record,
      });

      expect(summary).toMatchObject({ successful: 0, failed: 0 });
      expect(summary.errorBreakdown.size).toBe(0);
      expect(requests).toHaveLength(0);
      expect(allLines).toHaveLength(0);
    } finally {
      _resetInterruptState();
    }
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
      record,
    });

    const emails = requests.filter((r) => r.url.endsWith("/v1/email_addresses"));
    expect(emails.map((r) => r.body)).toEqual([
      { user_id: "user_created", email_address: "b@x.dev", primary: false, verified: true },
      { user_id: "user_created", email_address: "c@x.dev", primary: false, verified: false },
    ]);
    expect(requests.filter((r) => r.url.endsWith("/v1/phone_numbers"))).toHaveLength(1);
  });

  test("marks a user whose password the source dropped", async () => {
    stub(() => ok("user_created"));

    await importUsers({
      users: [user({ passwordDropped: true })],
      secretKey: "sk_test_x",
      limits: LIMITS,
      record,
    });

    expect(lines[0]).toMatchObject({ status: "created", passwordDropped: true });
    // Never sent: it is the CLI's own bookkeeping, not a Clerk field.
    expect(JSON.stringify(requests[0]?.body)).not.toContain("passwordDropped");
  });

  test("notes a failed additional identifier without failing the user", async () => {
    stub((url) =>
      url.endsWith("/v1/email_addresses")
        ? clerkError(422, "that email is taken")
        : ok("user_created"),
    );

    const summary = await importUsers({
      users: [user({ email: ["a@x.dev", "b@x.dev"] })],
      secretKey: "sk_test_x",
      limits: LIMITS,
      record,
    });

    expect(summary).toMatchObject({ successful: 1, failed: 0 });
    // On record once created, then with its attach pending, then with what
    // the attach added. A refused attach is not retried, so nothing is pending.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({ sourceId: "u1", clerkId: "user_created", status: "created" });
    expect(lines[1]?.pending).toEqual([{ kind: "email", value: "b@x.dev", verified: true }]);
    expect(lines[2]).toMatchObject({ status: "created", clerkId: "user_created" });
    expect(lines[2]?.error).toContain("Failed to add additional email b@x.dev");
    expect(lines[2]).not.toHaveProperty("pending");
  });

  test("retries an attach that hits a 429", async () => {
    stub((url, attempt) =>
      url.endsWith("/v1/email_addresses") && attempt === 1
        ? clerkError(429, "slow down", { "retry-after": "1" })
        : ok("user_created"),
    );

    await importUsers({
      users: [user({ email: ["a@x.dev", "b@x.dev"] })],
      secretKey: "sk_test_x",
      limits: LIMITS,
      record,
    });

    expect(requests.filter((r) => r.url.endsWith("/v1/email_addresses"))).toHaveLength(2);
    expect(lines.at(-1)).not.toHaveProperty("error");
    expect(lines.at(-1)).not.toHaveProperty("pending");
  });

  test("keeps an attach with no answer pending", async () => {
    stub((url) =>
      url.endsWith("/v1/email_addresses") ? clerkError(503, "unavailable") : ok("user_created"),
    );

    await importUsers({
      users: [user({ email: ["a@x.dev", "b@x.dev"] })],
      secretKey: "sk_test_x",
      limits: LIMITS,
      record,
    });

    expect(lines.at(-1)?.pending).toEqual([{ kind: "email", value: "b@x.dev", verified: true }]);
  });

  // One slot: a user's attaches go ahead of the next queued create, so a run
  // stopped midway leaves few users without their extra identifiers.
  test("attaches a user's identifiers before the next queued create", async () => {
    stub((url) => ok(url.endsWith("/v1/users") ? "user_created" : "idn_1"));

    await importUsers({
      users: [
        user({ userId: "u1", email: ["a@x.dev", "b@x.dev"] }),
        user({ userId: "u2", email: ["c@x.dev", "d@x.dev"] }),
        user({ userId: "u3", email: ["e@x.dev", "f@x.dev"] }),
      ],
      secretKey: "sk_test_x",
      limits: { ...LIMITS, concurrencyLimit: 1 },
      record,
    });

    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/v1/users",
      "/v1/email_addresses",
      "/v1/users",
      "/v1/email_addresses",
      "/v1/users",
      "/v1/email_addresses",
    ]);
  });

  // Shapes from clerk_go's apierror: the country error carries its own code
  // and no param_name; the E.164 error is a form error on phone_number.
  test.each([
    [
      403,
      {
        code: "unsupported_country_code",
        message: "Unsupported country code",
        long_message: "Phone numbers from this country (Netherlands) are currently not supported.",
        meta: { alpha2: "NL", country_code: "31" },
      },
    ],
    [
      422,
      {
        code: "form_param_format_invalid",
        message: "is invalid",
        long_message:
          "Phone number must be a valid phone number according to E.164 international standard.",
        meta: { param_name: "phone_number" },
      },
    ],
  ])("retries without a phone Clerk refuses (%i), and notes it", async (status, clerkErr) => {
    stub((url, attempt) =>
      url.endsWith("/v1/users") && attempt === 1
        ? new Response(JSON.stringify({ errors: [clerkErr] }), { status })
        : ok("user_created"),
    );

    const summary = await importUsers({
      users: [user({ phone: "+31612345678" })],
      secretKey: "sk_test_x",
      limits: LIMITS,
      record,
    });

    expect(summary).toMatchObject({ successful: 1, failed: 0 });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).not.toHaveProperty("phone_number");
    expect(lines.at(-1)?.error).toContain(
      `Failed to add phone +31612345678: ${clerkErr.long_message}`,
    );
  });

  test("does not retry without the phone when it is the only identifier", async () => {
    stub(
      () =>
        new Response(
          JSON.stringify({
            errors: [{ code: "x", message: "bad phone", meta: { param_name: "phone_number" } }],
          }),
          { status: 422 },
        ),
    );

    const summary = await importUsers({
      users: [user({ email: undefined, phone: "+31612345678" })],
      secretKey: "sk_test_x",
      limits: LIMITS,
      record,
    });

    expect(summary.failed).toBe(1);
    expect(requests).toHaveLength(1);
  });

  // The marker `undo` uses to find a user whose create was in flight when the
  // run stopped.
  test("marks each user as creating before its POST /v1/users", async () => {
    let recordedBeforePost = false;
    stub((url) => {
      if (url.endsWith("/v1/users")) {
        recordedBeforePost = allLines.some((line) => line.status === "creating");
      }
      return ok("user_created");
    });

    await importUsers({ users: [user()], secretKey: "sk_test_x", limits: LIMITS, record });

    expect(recordedBeforePost).toBe(true);
    expect(allLines.map((line) => line.status)).toEqual(["creating", "created"]);
  });

  // A run stopped while attaches wait on the scheduler must still have the
  // user on record, or `undo` leaves it behind.
  test("records the user before its additional identifiers attach", async () => {
    let recordedBeforeAttach = false;
    stub((url) => {
      if (url.endsWith("/v1/email_addresses")) {
        recordedBeforeAttach = lines.some(
          (line) => line.status === "created" && line.clerkId === "user_created",
        );
      }
      return ok("user_created");
    });

    await importUsers({
      users: [user({ email: ["a@x.dev", "b@x.dev"] })],
      secretKey: "sk_test_x",
      limits: LIMITS,
      record,
    });

    expect(recordedBeforeAttach).toBe(true);
  });

  // A user is on record only once its create may land, so `undo` never
  // looks up users that were still queued when the run stopped.
  test("writes creating only as each POST /v1/users goes out", async () => {
    const creatingAtFirstPost: number[] = [];
    stub((url) => {
      if (url.endsWith("/v1/users") && creatingAtFirstPost.length === 0) {
        creatingAtFirstPost.push(allLines.filter((line) => line.status === "creating").length);
      }
      return ok("user_created");
    });

    await importUsers({
      users: [user({ userId: "u1" }), user({ userId: "u2" }), user({ userId: "u3" })],
      secretKey: "sk_test_x",
      limits: { ...LIMITS, concurrencyLimit: 1 },
      record,
    });

    expect(creatingAtFirstPost).toEqual([1]);
  });

  test.each([
    ["a 5xx", () => clerkError(502, "bad gateway")],
    [
      "a network error",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("a create that gets %s keeps creating, not failed", async (_label, respond) => {
    stub(respond);

    const summary = await importUsers({
      users: [user()],
      secretKey: "sk_test_x",
      limits: LIMITS,
      record,
    });

    expect(summary.failed).toBe(1);
    expect(allLines.map((line) => line.status)).toEqual(["creating"]);
    expect([...summary.errorBreakdown.keys()][0]).toContain("a re-run checks");
  });

  test("leaves a create answered without a user ID as unknown, never created", async () => {
    stub(() => new Response(JSON.stringify({}), { status: 200 }));

    const summary = await importUsers({
      users: [user({ userId: "u1" })],
      secretKey: "sk_test_x",
      limits: LIMITS,
      record,
    });

    expect(summary).toMatchObject({ successful: 0, failed: 1 });
    expect(allLines).toEqual([{ sourceId: "u1", status: "creating" }]);
  });

  test("records a failed user and keeps going", async () => {
    stub((_url, attempt) =>
      attempt === 1 ? clerkError(422, "that email is taken") : ok("user_ok"),
    );

    const summary = await importUsers({
      users: [user({ userId: "u1" }), user({ userId: "u2", email: "b@x.dev" })],
      secretKey: "sk_test_x",
      limits: LIMITS,
      record,
    });

    expect(summary.successful + summary.failed).toBe(2);
    expect(summary.failed).toBe(1);
    expect([...summary.errorBreakdown.values()]).toEqual([1]);
    expect(lines.some((line) => line.status === "failed" && line.code === "422")).toBe(true);
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
      record,
    });

    expect(summary).toMatchObject({ successful: 1, failed: 0 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(900);
    expect(requests.filter((r) => r.url.endsWith("/v1/users"))).toHaveLength(2);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ status: "created", clerkId: "user_ok" });
    expect(lines[1]?.error).toContain("Rate limit hit (429)");
  });

  test("gives up after the retry ceiling and records the user as failed", async () => {
    stub(() => clerkError(429, "slow down", { "retry-after": "1" }));

    const summary = await importUsers({
      users: [user()],
      secretKey: "sk_test_x",
      limits: LIMITS,
      record,
    });

    expect(summary).toMatchObject({ successful: 0, failed: 1 });
    // One initial attempt plus MAX_RETRIES retries.
    expect(requests.filter((r) => r.url.endsWith("/v1/users"))).toHaveLength(6);
    expect(lines).toMatchObject([{ status: "failed", code: "429" }]);
  }, 20_000);

  test("carries the validation failure count into the summary", async () => {
    stub(() => ok("user_ok"));

    const summary = await importUsers({
      users: [user()],
      secretKey: "sk_test_x",
      limits: LIMITS,
      record,
      validationFailed: 4,
    });

    expect(summary.validationFailed).toBe(4);
  });
});
