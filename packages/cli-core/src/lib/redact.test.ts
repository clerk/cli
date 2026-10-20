import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import {
  EMAIL_MARKER,
  REDACTED,
  REDACTION_MARGIN,
  redactAndCap,
  redactText,
  URL_PASSWORD_MAX_LENGTH,
} from "./redact.ts";

// Tests inject a home directory so the literal pass is deterministic on every
// machine; the generic `/Users/<name>` pass runs regardless.
const HOME = "/srv/people/dave";
const redact = (text: string) => redactText(text, { homedir: HOME });

const PRIVATE_KEY_BODY = "MIIEowIBAAKCAQEA7x9secretbody";
const PRIVATE_KEY_BLOCK = `-----BEGIN RSA PRIVATE KEY-----\n${PRIVATE_KEY_BODY}\n-----END RSA PRIVATE KEY-----`;

// Assembled at runtime rather than written as literals: GitHub push protection
// rejects a push whose files contain anything shaped like these, fake or not.
const AWS_ACCESS_KEY_ID = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
const GOOGLE_API_KEY = ["AIza", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("");
const STRIPE_WEBHOOK_SECRET = ["whsec_", "abcdefghijklmnopqrstuvwxyz"].join("");
const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0In0", "abcdefghijklmnop"].join(".");

// Values carry no `sk_`/`pk_` prefix wherever the *name* pattern is what is
// under test: a value that matches the key pattern would pass on that alone
// and prove nothing about the name pattern.
describe("secret shapes never reach the output", () => {
  test.each([
    ["terminated private key block", PRIVATE_KEY_BLOCK, PRIVATE_KEY_BODY],
    [
      "Authorization: Bearer header",
      "Authorization: Bearer abcdef1234567890xyz",
      "abcdef1234567890xyz",
    ],
    ["Bearer token in prose", "sent Bearer abc123def456ghi789 and got 401", "abc123def456ghi789"],
    // btoa("alice:hunter2")
    [
      "Basic user:password in prose",
      "sent Basic YWxpY2U6aHVudGVyMg== and got 401",
      "YWxpY2U6aHVudGVyMg==",
    ],
    ["Clerk secret key", "key sk_test_abc123DEF456 rejected", "sk_test_abc123DEF456"],
    ["Clerk publishable key", "key pk_live_abc123DEF456 rejected", "pk_live_abc123DEF456"],
    ["Clerk restricted key", "key rk_test_abc123DEF456 rejected", "rk_test_abc123DEF456"],
    ["GitHub token", "GH ghp_abcdefghijklmnopqrstuvwxyz0123", "ghp_abcdefghijklmnopqrstuvwxyz0123"],
    [
      "GitHub fine-grained token",
      "GH github_pat_abcdefghijklmnopqrstuvwxyz_0123",
      "github_pat_abcdefghijklmnopqrstuvwxyz_0123",
    ],
    ["Slack token", "slack xoxb-1234567890-abcdefghij", "xoxb-1234567890-abcdefghij"],
    ["npm token", "npm npm_abcdefghijklmnopqrstuvwxyz0123", "npm_abcdefghijklmnopqrstuvwxyz0123"],
    ["AWS access key id", `aws ${AWS_ACCESS_KEY_ID}`, AWS_ACCESS_KEY_ID],
    ["Google API key", `google ${GOOGLE_API_KEY}`, GOOGLE_API_KEY],
    ["Google client secret", "google GOCSPX-abcdefgh1234", "GOCSPX-abcdefgh1234"],
    ["Stripe webhook secret", `stripe ${STRIPE_WEBHOOK_SECRET}`, STRIPE_WEBHOOK_SECRET],
    ["JWT", `jwt ${JWT}`, JWT],
    ["bare api_key=value", "config api_key=plainvalue123", "plainvalue123"],
    ["bare token: value", 'config token: "plainvalue123"', "plainvalue123"],
    ["bare password in JSON", '{"password": "hunter2"}', "hunter2"],
    // CLI additions.
    ["Platform API key", "key ak_1234567890abcdef rejected", "ak_1234567890abcdef"],
    ["CLERK_SECRET_KEY with a non-sk value", "CLERK_SECRET_KEY=notsk_value_123", "notsk_value_123"],
    [
      "exported CLERK_PLATFORM_API_KEY with a non-ak value",
      "export CLERK_PLATFORM_API_KEY=plain_value_456",
      "plain_value_456",
    ],
    ["DATABASE_PASSWORD", "DATABASE_PASSWORD=hunter2", "hunter2"],
    ["lowercase name containing passwd", "my_passwd: letmein", "letmein"],
    ["camelCase JSON name containing token", '"githubToken": "plain_value_789"', "plain_value_789"],
    ["camelCase name ending in ApiKey", "clerkApiKey=plainvalue123", "plainvalue123"],
    ["camelCase JSON name ending in ApiKey", '"clerkApiKey": "plainvalue123"', "plainvalue123"],
    ["camelCase name ending in PrivateKey", "sshPrivateKey=plain_value_333", "plain_value_333"],
    ["name containing PRIVATE_KEY", "NPM_PRIVATE_KEY=plain_value_000", "plain_value_000"],
    ["name containing ENCRYPTION_KEY", "CLERK_ENCRYPTION_KEY=a1b2c3d4e5f6g7h8", "a1b2c3d4e5f6g7h8"],
    [
      "camelCase name ending in EncryptionKey",
      '"dbEncryptionKey": "a1b2c3d4e5f6g7h8"',
      "a1b2c3d4e5f6g7h8",
    ],
    [
      "name containing API_KEY in a URL query",
      "GET /x?MY_API_KEY=plain_value_111",
      "plain_value_111",
    ],
    ["name that is a whole-word AUTH segment", "X_AUTH=plain_value_444", "plain_value_444"],
    ["name containing AUTHORIZATION", "MY_AUTHORIZATION=plain_value_555", "plain_value_555"],
    ["credentials in a URL", "postgres://alice:hunter2@db.example.com:5432/app", "alice:hunter2"],
    [
      "unterminated private key block",
      `log:\n-----BEGIN PRIVATE KEY-----\n${PRIVATE_KEY_BODY}\nmore lines`,
      PRIVATE_KEY_BODY,
    ],
  ])("%s", (_label, input, secret) => {
    const { text, redactions } = redact(input);
    expect(text).not.toContain(secret);
    expect(text).toContain(REDACTED);
    expect(redactions).toBeGreaterThanOrEqual(1);
  });
});

describe("exact replacements", () => {
  test("a Clerk secret key inside a longer error message is replaced and the rest survives", () => {
    expect(redact("Request failed: Invalid key sk_test_abc123 for instance ins_1")).toEqual({
      text: `Request failed: Invalid key ${REDACTED} for instance ins_1`,
      redactions: 1,
    });
  });

  test("a named assignment keeps the name and loses the value", () => {
    expect(redact("export CLERK_SECRET_KEY=notsk_abc")).toEqual({
      text: `export CLERK_SECRET_KEY=${REDACTED}`,
      redactions: 1,
    });
  });

  test("an unterminated private key block is scrubbed to the end of the field", () => {
    expect(redact("log:\n-----BEGIN PRIVATE KEY-----\nMIIabc\nmore lines")).toEqual({
      text: `log:\n${REDACTED}`,
      redactions: 1,
    });
  });

  test("an email in prose is replaced", () => {
    expect(redact("contact alice@example.com for help")).toEqual({
      text: `contact ${EMAIL_MARKER} for help`,
      redactions: 1,
    });
  });

  test("the count sums one of each kind", () => {
    const { redactions } = redact(
      "sk_test_abc123 failed at /Users/alice/app/index.ts, ask alice@example.com",
    );
    expect(redactions).toBe(3);
  });

  test("an empty string is returned as is", () => {
    expect(redact("")).toEqual({ text: "", redactions: 0 });
  });
});

// A shell value runs to the next whitespace; a JSON field's value stops at a
// comma or brace. Mixing the rules up either sends part of a password or
// wipes the rest of a one-line log.
describe("shell assignments and JSON fields stop differently", () => {
  // A name upstream also recognises (`password`, `auth`, `authorization`) ends
  // as upstream's whole-pair replacement, because that pass runs after this
  // one and takes `name=[REDACTED]` whole. The value is gone either way.
  test.each([
    ["DATABASE_PASSWORD=alpha,beta", `DATABASE_PASSWORD=${REDACTED}`],
    ["PASSWORD=alpha;beta", REDACTED],
    ["DB_PASSWD=alpha;beta tail", `DB_PASSWD=${REDACTED} tail`],
    ["auth=alpha,beta", REDACTED],
    ["authorization=abc,def", REDACTED],
    ["X_AUTH=abc,def rest", `X_AUTH=${REDACTED} rest`],
  ])("shell: %s → %s", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });

  test.each([
    [
      '{"apiToken":12345,"user":"bob","plan":"pro"}',
      `{"apiToken":${REDACTED},"user":"bob","plan":"pro"}`,
    ],
    ['"max_tokens":4096,"model":"x"', `"max_tokens":${REDACTED},"model":"x"`],
    ['"githubToken": "x", "a": 1', `"githubToken": ${REDACTED}, "a": 1`],
    ["{'password': 'pw', 'a': 1}", `{${REDACTED}, 'a': 1}`],
  ])("JSON: %s → %s", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });

  // `AUTH` must be a whole segment of the name, or every OAuth setting and
  // every author field would be scrubbed.
  test.each([["oauth_client_id=abc"], ["author=alice"], ["OAUTH_REDIRECT=https://x.io/cb"]])(
    "%s is left alone",
    (input) => {
      expect(redact(input)).toEqual({ text: input, redactions: 0 });
    },
  );
});

// The private-key passes run before the named-assignment pass: that pass
// stops a shell value at whitespace, so run first it would take only the
// `-----BEGIN` word and leave the key body with nothing left to match it.
describe("a private key pasted after its variable name", () => {
  test("a terminated block is taken whole and counted once", () => {
    expect(redact(`JWT_PRIVATE_KEY=${PRIVATE_KEY_BLOCK}`)).toEqual({
      text: `JWT_PRIVATE_KEY=${REDACTED}`,
      redactions: 1,
    });
  });

  test("an unterminated block is taken to the end and counted once", () => {
    expect(
      redact(`JWT_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n${PRIVATE_KEY_BODY}\nmore`),
    ).toEqual({
      text: `JWT_PRIVATE_KEY=${REDACTED}`,
      redactions: 1,
    });
  });
});

describe("the count is one per secret for the common shapes", () => {
  test.each([
    // The named pass takes these whole before the key or URL passes see them.
    ['CLERK_SECRET_KEY="sk_live_abc123"', `CLERK_SECRET_KEY=${REDACTED}`],
    ["CLERK_SECRET_KEY=sk_test_abc123", `CLERK_SECRET_KEY=${REDACTED}`],
    [
      "DATABASE_URL_PASSWORD=postgres://u:pw@db.example.com/app",
      `DATABASE_URL_PASSWORD=${REDACTED}`,
    ],
    // The scheme pass runs first and leaves `TOKEN="[REDACTED]` (upstream
    // drops the closing quote); the named pass must see through the stray
    // quote and not count it again, and upstream then takes the pair whole.
    ['TOKEN="Bearer abcdefgh1234"', REDACTED],
    // The same with a name upstream does not know keeps the name.
    ['MY_TOKEN="Bearer abcdefgh1234"', `MY_TOKEN="${REDACTED}`],
    // The scheme pass takes `Bearer x`, then the key-value pass takes the
    // leftover `Authorization: [REDACTED]`. Same output as upstream, one count.
    ["Authorization: Bearer abcdef1234567890xyz", REDACTED],
    // A value that already contains the marker text is still new content.
    ["token=abc[REDACTED]", REDACTED],
  ])("%s → %s", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });

  // Pinned safety case: a quoted value with a key inside it must go whole,
  // whatever the counting rules do.
  test("a quoted value holding both a plain password and a key loses both", () => {
    const { text } = redact('PASSWORD="hunter2 sk_test_abc" next');
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("sk_test_abc");
    expect(text).toEndWith(" next");
  });

  test("an unterminated key block that swallows an earlier marker still counts itself", () => {
    expect(redact("-----BEGIN PRIVATE KEY-----\nMIIabc Bearer abcdefgh1234")).toEqual({
      text: REDACTED,
      redactions: 2,
    });
  });
});

// The whole header value goes, whatever the scheme. The scheme pass alone
// rejects an all-letter token and the named pass alone would take only the
// scheme word, leaving the credential for nothing else to catch.
describe("Authorization headers", () => {
  test.each([
    ["Authorization: Bearer abcdefghijkl", REDACTED],
    ["Authorization: token abc123", REDACTED],
    ["Authorization: ApiKey plain_value_666", REDACTED],
    ["authorization=Bearer abcdefghijkl", REDACTED],
    ['{"Authorization":"token abc","a":1}', `{${REDACTED},"a":1}`],
    ["Authorization: Bearer abcdefghijkl\nnext line", `${REDACTED}\nnext line`],
  ])("%s → %s", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });
});

// A quoted value whose closing quote never arrives (a truncated log, or a
// value the pre-cut split) must not fall back to the unquoted stop rule, which
// would send everything after the first comma or space.
describe("an unterminated quoted value runs to the end of its line", () => {
  test.each([
    ['{"password":"alpha,beta', `{${REDACTED}`],
    ['{"apiToken":"alpha,beta', `{"apiToken":${REDACTED}`],
    ['{"api key":"alpha,beta', `{${REDACTED}`],
    ['PASSWORD="alpha beta gamma', REDACTED],
    ['DB_PASSWD="alpha beta gamma', `DB_PASSWD=${REDACTED}`],
    ["DB_PASSWD='alpha beta gamma", `DB_PASSWD=${REDACTED}`],
    ['DB_PASSWD="alpha beta\nNEXT=1', `DB_PASSWD=${REDACTED}\nNEXT=1`],
    // An escaped quote inside the value is not the end of it.
    ['DB_PASSWD="alpha\\" beta gamma', `DB_PASSWD=${REDACTED}`],
    ['{"apiToken":"alpha\\" beta', `{"apiToken":${REDACTED}`],
  ])("%s → %s", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });
});

describe("URL credentials", () => {
  test.each([
    [
      "postgres://alice:hunter2@db.example.com:5432/app",
      "alice:hunter2",
      "db.example.com:5432/app",
    ],
    // An empty username is still a credential.
    ["redis://:s3cr3tPass@10.0.0.5:6379", ":s3cr3tPass", "10.0.0.5:6379"],
    ["redis://:s3cr3tPass@localhost:6379", ":s3cr3tPass", "localhost:6379"],
    // A raw connection string whose password holds `/` or `@` is still taken whole.
    ["postgres://u:pa/ss@db.example.com/app", "pa/ss", "db.example.com/app"],
    ["postgres://u:p@ss@localhost:5432/app", "p@ss", "localhost:5432/app"],
  ])("%s: the credential goes, the host stays", (input, secret, host) => {
    const { text, redactions } = redact(input);
    expect(text).not.toContain(secret);
    expect(text).toContain(`://${REDACTED}@${host}`);
    expect(redactions).toBe(1);
  });

  // The email pass runs after the URL pass and must not re-read the marker it
  // left behind as an address.
  test("the host left after a URL credential is not then taken as an email", () => {
    expect(redact("https://alice:pw@example.com/x")).toEqual({
      text: `https://${REDACTED}@example.com/x`,
      redactions: 1,
    });
  });

  test("a plain URL followed by an email in prose keeps the URL", () => {
    expect(redact("see https://clerk.com/docs for alice@x.io")).toEqual({
      text: `see https://clerk.com/docs for ${EMAIL_MARKER}`,
      redactions: 1,
    });
  });

  // Pinned limit: beyond the bound the URL pass gives up; the email pass still
  // removes the password, but the username before it survives.
  test(`a password longer than ${URL_PASSWORD_MAX_LENGTH} characters is outside the URL pass`, () => {
    const password = "p".repeat(URL_PASSWORD_MAX_LENGTH + 1);
    const { text } = redact(`postgres://u:${password}@h.example.com/app`);
    expect(text).not.toContain(password);
    expect(text).toBe(`postgres://u:${EMAIL_MARKER}/app`);
  });
});

describe("home-directory paths", () => {
  test.each([
    ["/Users/alice/app/src", "~/app/src"],
    ["/home/bob/.config/clerk", "~/.config/clerk"],
    ["C:\\Users\\carol\\proj\\x", "~\\proj\\x"],
    ["error at /Users/alice/app/index.ts:3", "error at ~/app/index.ts:3"],
    ["cwd /Users/alice", "cwd ~"],
    // Stack traces print paths as file:// URLs.
    ["at file:///Users/alice/app/index.ts:3:1", "at file://~/app/index.ts:3:1"],
    ["at file:///home/bob/app/index.ts:3:1", "at file://~/app/index.ts:3:1"],
    // A Windows path inside a JSON string has doubled backslashes; a lowercase one is still Windows.
    ["C:\\\\Users\\\\alice\\\\app", "~\\\\app"],
    ["c:\\users\\alice", "~"],
    // The injected home directory, whatever its shape.
    [`${HOME}/app`, "~/app"],
    [`cd ${HOME}`, "cd ~"],
    [`at file://${HOME}/app/x.ts:1:1`, "at file://~/app/x.ts:1:1"],
  ])("%s → %s", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });

  test("a Windows home directory also matches its JSON-escaped spelling", () => {
    expect(redactText("C:\\\\Users\\\\dave\\\\app", { homedir: "C:\\Users\\dave" })).toEqual({
      text: "~\\\\app",
      redactions: 1,
    });
  });

  test.each([
    // A longer name that merely starts with the home directory is someone else's.
    [`${HOME}2/app`],
    // A URL path segment is not a home directory.
    ["https://example.com/Users/alice"],
    // A Backend API path: the POSIX forms are case-sensitive on purpose.
    ["clerk api /users/user_2abc returned 404"],
    // No user segment.
    ["/Users/"],
    ["see /home"],
  ])("%s is left alone", (input) => {
    expect(redact(input)).toEqual({ text: input, redactions: 0 });
  });

  // A one-segment or root home directory would turn every path into `~`.
  test.each([["/"], [""], ["C:"]])("an unusable homedir %j is ignored", (home) => {
    expect(redactText("/etc/hosts and /var/log", { homedir: home })).toEqual({
      text: "/etc/hosts and /var/log",
      redactions: 0,
    });
  });

  test("the default home directory is the current user's", () => {
    expect(redactText(`${homedir()}/app`)).toEqual({ text: "~/app", redactions: 1 });
  });
});

describe("ordinary prose is untouched", () => {
  test.each([
    ["the bearer of this token has basic access"],
    ["set a password and auth before you continue"],
    ["Okta is Basic enough"],
    ["sk_ keys start with sk_test_ or sk_live_"],
  ])("%s", (input) => {
    expect(redact(input)).toEqual({ text: input, redactions: 0 });
  });
});

// Accepted over- and under-matches, pinned so a later change to them is deliberate.
describe("known limitations", () => {
  test("a user segment in a URL without a password is taken as an email", () => {
    expect(redact("https://git@github.com/clerk/cli")).toEqual({
      text: `https://${EMAIL_MARKER}/clerk/cli`,
      redactions: 1,
    });
  });

  test("any name containing TOKEN is treated as a secret", () => {
    expect(redact("max_tokens=4096")).toEqual({
      text: `max_tokens=${REDACTED}`,
      redactions: 1,
    });
  });

  test("a URL with a port and an email in its query string loses its host", () => {
    expect(redact("https://host:8080/x?e=a@b.com")).toEqual({
      text: `https://${REDACTED}@b.com`,
      redactions: 1,
    });
  });

  test("prose naming the Authorization header loses the rest of its line", () => {
    expect(redact("set the Authorization: header first\nthen retry")).toEqual({
      text: `set the ${REDACTED}\nthen retry`,
      redactions: 1,
    });
  });

  test("a home directory whose user name contains a space keeps the second word", () => {
    expect(redact("/Users/John Smith/app/x.ts")).toEqual({
      text: "~ Smith/app/x.ts",
      redactions: 1,
    });
  });

  // The upstream key-value pass replaces the whole pair for the names it
  // knows, so the variable name goes with the value. Not a leak.
  test("a shell export of an upstream-known name loses the name too", () => {
    expect(redact("export TOKEN=plain_value_1")).toEqual({
      text: `export ${REDACTED}`,
      redactions: 1,
    });
  });
});

// Two patterns were quadratic in the size of a pasted blob (the named pass on
// any long run of name characters, the URL pass on long dotted runs); each
// took seconds at 100 to 200 KB. Fixed they take single-digit milliseconds, so
// the bound below has two orders of magnitude of headroom for a busy runner
// and still fails on a regression to quadratic.
describe("large pastes stay linear", () => {
  const NAME_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function blob(size: number): string {
    let out = "";
    for (let i = 0; i < size; i++) out += NAME_CHARS[(i * 7919) % NAME_CHARS.length];
    return out;
  }
  const urlHeavyJson =
    "[" +
    Array.from({ length: 4000 }, (_, i) => `{"u":"http://localhost:3000/p/${i}"}`).join(",") +
    "]";

  test.each([
    ["200 KB run of name characters", blob(200_000)],
    ["100 KB dotted run", "a.".repeat(50_000)],
    ["100 KB dashed run", "a-".repeat(50_000)],
    ["one-line JSON holding 4,000 URLs", urlHeavyJson],
    // A lazy BEGIN…END pattern with no END rescans to the end from every BEGIN.
    ["24,000 BEGIN markers with no END", "-----BEGIN PRIVATE KEY-----\nMIIabc\n".repeat(24_000)],
  ])("%s finishes well under a second", (_label, input) => {
    const started = performance.now();
    redact(input);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe("redactAndCap", () => {
  const CAP = 2000;
  const capped = (text: string) => redactAndCap(text, CAP, { homedir: HOME });

  test("short text is scrubbed and returned whole", () => {
    expect(capped("key sk_test_abc123 at /Users/alice/x")).toEqual({
      text: `key ${REDACTED} at ~/x`,
      redactions: 2,
    });
  });

  test("the output never exceeds the cap", () => {
    expect(capped("x".repeat(CAP + 10)).text).toHaveLength(CAP);
  });

  // The marker that replaces a secret can itself straddle the cap. The final
  // cut never leaves a partial marker: it keeps a whole one or drops it.
  test("a secret that starts inside the cap and runs past it is scrubbed, and the marker is not split", () => {
    const padding = "x".repeat(CAP - 6);
    expect(capped(`${padding} sk_test_abcdef123456 trailing`)).toEqual({
      text: `${padding} `,
      redactions: 1,
    });
  });

  test("a marker that ends exactly at the cap is kept whole", () => {
    const padding = "x".repeat(CAP - 1 - REDACTED.length);
    expect(capped(`${padding} sk_test_abcdef123456 trailing`)).toEqual({
      text: `${padding} ${REDACTED}`,
      redactions: 1,
    });
  });

  test("an email marker that straddles the cap is dropped whole", () => {
    const padding = "x".repeat(CAP - 4);
    expect(capped(`${padding} a@b.io tail`)).toEqual({ text: `${padding} `, redactions: 1 });
  });

  // The pre-cut lands inside this quoted value; what is left is an
  // unterminated quote, which runs to the end of its line and is taken whole.
  test("a quoted value the pre-cut splits is still fully redacted", () => {
    const padding = "x".repeat(CAP - 21);
    const input = `${padding} DB_PASSWD="${"s".repeat(REDACTION_MARGIN + 100)}`;
    expect(input.length).toBeGreaterThan(CAP + REDACTION_MARGIN);
    expect(capped(input)).toEqual({ text: `${padding} DB_PASSWD=${REDACTED}`, redactions: 1 });
  });

  // The pre-cut lands inside this key's body. The unterminated-block pass is
  // what makes the first cut safe: it takes the block from BEGIN to the end.
  test("a private key block that straddles the pre-cut boundary is still fully redacted", () => {
    const body = "A".repeat(REDACTION_MARGIN + 2000);
    const input = `${"x".repeat(CAP - 50)}-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    expect(input.length).toBeGreaterThan(CAP + REDACTION_MARGIN);
    expect(capped(input)).toEqual({ text: `${"x".repeat(CAP - 50)}${REDACTED}`, redactions: 1 });
  });

  // Documented property: text beyond the bound is never read, so a secret
  // there is neither sent nor counted.
  test("replacements beyond the bound are not counted", () => {
    const { text, redactions } = capped("x".repeat(CAP + REDACTION_MARGIN) + " sk_test_abc123");
    expect(redactions).toBe(0);
    expect(text).toBe("x".repeat(CAP));
  });

  // Earlier redactions can shrink the text by more than the margin, which
  // slides whatever straddled the pre-cut boundary (a token cut in half, too
  // short to match its pattern) inside the cap. Fixtures are built at runtime.
  test("a token the pre-cut splits never reaches the output, even when earlier redactions pull it inside the cap", () => {
    const key = ["sk_test_", "a".repeat(92)].join("");
    const token = ["ghp_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("");
    const keys = Array.from({ length: 100 }, () => key).join(" ");
    const filler = "x".repeat(CAP + REDACTION_MARGIN - keys.length - 2 - 14);
    const input = `${keys} ${filler} ${token} tail`;
    // The boundary falls 14 characters into the token.
    expect(input.slice(CAP + REDACTION_MARGIN - 14, CAP + REDACTION_MARGIN)).toBe(
      token.slice(0, 14),
    );
    const { text } = capped(input);
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("ABCDEFGHIJ");
    expect(text.length).toBeLessThanOrEqual(CAP);
  });

  // The cap is in UTF-16 code units; a character outside the BMP is two of
  // them, and half of one is not text.
  test("the cut never splits a surrogate pair", () => {
    const { text } = capped(`${"x".repeat(CAP - 1)}😀 tail`);
    expect(text.isWellFormed()).toBe(true);
    expect(text).toBe("x".repeat(CAP - 1));
  });

  // The pre-cut lands inside a quoted value that contains an escaped quote;
  // what is left must still run to the end of its line.
  test("a quoted value with an escaped quote that the pre-cut splits is still fully redacted", () => {
    const padding = "x".repeat(CAP - 21);
    const input = `${padding} DB_PASSWD="al\\"pha${"s".repeat(REDACTION_MARGIN + 100)}" tail`;
    expect(capped(input)).toEqual({ text: `${padding} DB_PASSWD=${REDACTED}`, redactions: 1 });
  });
});

// `--name value` and `--name=value` where the flag name contains a
// secret-looking word: the value goes, the flag stays. A value cannot itself
// be a flag, so `--token --other` is left alone.
describe("flags with a secret-looking name", () => {
  test.each([
    [
      "clerk users list --password Hunter2Secret! --limit 5",
      `clerk users list --password ${REDACTED} --limit 5`,
    ],
    ["--token c_Ab12Cd34Ef", `--token ${REDACTED}`],
    ["--api-key plain_value_999 next", `--api-key ${REDACTED} next`],
    // `=` form with a name upstream also knows: the upstream key-value pass
    // then takes `password=[REDACTED]` whole, as it does for any `password=`.
    ["--db-password=plain_value_888 next", `--db-${REDACTED} next`],
    ["--db-encryption-key=plain_value_888 next", `--db-encryption-key=${REDACTED} next`],
    ['--auth-token "quoted value" next', `--auth-token ${REDACTED} next`],
    ["--encryption-key plain_value_777", `--encryption-key ${REDACTED}`],
    // Any name containing TOKEN, as for assignments.
    ["--max-tokens 4096", `--max-tokens ${REDACTED}`],
    ['curl --authorization "token abc123def456" x', `curl --authorization ${REDACTED} x`],
    ["--authorization token_abc123def456", `--authorization ${REDACTED}`],
  ])("%s → %s", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });

  test.each([["--token --other"], ["--author alice"], ["--authorize now"]])(
    "%s is left alone",
    (input) => {
      expect(redact(input)).toEqual({ text: input, redactions: 0 });
    },
  );
});

// JSON pasted inside a string has its quotes escaped (`{\"password\":\"x\"}`).
describe("escaped JSON inside a string", () => {
  test.each([
    [
      '{\\"password\\":\\"hunter2xyz\\",\\"user\\":\\"a\\"}',
      `{\\"password\\":${REDACTED},\\"user\\":\\"a\\"}`,
    ],
    ['{\\"apiToken\\":\\"plain_value_123\\"}', `{\\"apiToken\\":${REDACTED}}`],
    // Unterminated, as a truncated log leaves it.
    ['log: {\\"password\\":\\"hunter2xyz', `log: {\\"password\\":${REDACTED}`],
  ])("%s → %s", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });
});
