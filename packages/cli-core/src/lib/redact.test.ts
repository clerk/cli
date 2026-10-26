import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { FEEDBACK_FIELD_MAX_LENGTH } from "./constants.ts";
import {
  EMAIL_MARKER,
  REDACTED,
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
const OPENAI_KEY = ["sk-", "proj-", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef"].join("");
const ANTHROPIC_KEY = ["sk-", "ant-api03-", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef"].join("");
const PGP_BODY = "lQOYBGRpdmVyc2l0eXNlY3JldGJvZHk=";
const PGP_KEY_BLOCK = [
  ["-----BEGIN PGP", "PRIVATE KEY BLOCK-----"].join(" "),
  PGP_BODY,
  ["-----END PGP", "PRIVATE KEY BLOCK-----"].join(" "),
].join("\n");

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
    ["JWT right after a dash", `id-${JWT}`, JWT],
    ["PGP private key block", `log:\n${PGP_KEY_BLOCK}\nmore`, PGP_BODY],
    ["OpenAI project key", `error: invalid key ${OPENAI_KEY} (401)`, OPENAI_KEY],
    ["Anthropic key", `error: invalid x-api-key ${ANTHROPIC_KEY}`, ANTHROPIC_KEY],
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

  test("dots after a Bearer token stay", () => {
    expect(redact("sent Bearer abc123def456ghi789... then 401.")).toEqual({
      text: `sent ${REDACTED}... then 401.`,
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
  // The name always survives, whether or not it is one the MCP server's
  // patterns also know: a reader learns which variable was pasted, never its value.
  test.each([
    ["DATABASE_PASSWORD=alpha,beta", `DATABASE_PASSWORD=${REDACTED}`],
    ["PASSWORD=alpha;beta", `PASSWORD=${REDACTED}`],
    ["DB_PASSWD=alpha;beta tail", `DB_PASSWD=${REDACTED} tail`],
    ["auth=alpha,beta", `auth=${REDACTED}`],
    ["authorization=abc,def", `authorization=${REDACTED}`],
    ["X_AUTH=abc,def rest", `X_AUTH=${REDACTED} rest`],
    ["export TOKEN=plain_value_1", `export TOKEN=${REDACTED}`],
    // A shell word runs through a quoted part, spaces included.
    ['MY_TOKEN="alpha beta" next', `MY_TOKEN=${REDACTED} next`],
    ["token=abc[REDACTED]", `token=${REDACTED}`],
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
    ["{'password': 'pw', 'a': 1}", `{'password': ${REDACTED}, 'a': 1}`],
    ['{"api key": "pw", "a": 1}', `{"api key": ${REDACTED}, "a": 1}`],
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
    // The Bearer pass runs first and keeps the quotes around its marker; the
    // name pass then sees a value that is already the marker and does not
    // count it again.
    ['TOKEN="Bearer abcdefgh1234"', `TOKEN="${REDACTED}"`],
    ['MY_TOKEN="Bearer abcdefgh1234"', `MY_TOKEN="${REDACTED}"`],
    // The header pass takes the whole value; the Bearer pass then finds nothing.
    ["Authorization: Bearer abcdef1234567890xyz", `Authorization: ${REDACTED}`],
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

  // The key-block pass runs first, so a credential inside the block is part
  // of the one replacement, not a second one.
  test("an unterminated key block takes everything after it and counts once", () => {
    expect(redact("-----BEGIN PRIVATE KEY-----\nMIIabc Bearer abcdefgh1234")).toEqual({
      text: REDACTED,
      redactions: 1,
    });
  });
});

// The whole header value goes, whatever the scheme. The scheme pass alone
// rejects an all-letter token and the named pass alone would take only the
// scheme word, leaving the credential for nothing else to catch.
describe("Authorization headers", () => {
  test.each([
    ["Authorization: Bearer abcdefghijkl", `Authorization: ${REDACTED}`],
    ["Authorization: token abc123", `Authorization: ${REDACTED}`],
    ["Authorization: ApiKey plain_value_666", `Authorization: ${REDACTED}`],
    ["authorization=Bearer abcdefghijkl", `authorization=${REDACTED}`],
    ['{"Authorization":"token abc","a":1}', `{"Authorization":${REDACTED},"a":1}`],
    ["Authorization: Bearer abcdefghijkl\nnext line", `Authorization: ${REDACTED}\nnext line`],
    ['--authorization "token abc123def456" x', `--authorization ${REDACTED} x`],
  ])("%s → %s", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });
});

// A quoted value whose closing quote never arrives (a truncated log) must not
// fall back to the unquoted stop rule, which would send everything after the
// first comma or space.
describe("an unterminated quoted value runs to the end of its line", () => {
  test.each([
    ['{"password":"alpha,beta', `{"password":${REDACTED}`],
    ['{"apiToken":"alpha,beta', `{"apiToken":${REDACTED}`],
    ['{"api key":"alpha,beta', `{"api key":${REDACTED}`],
    ['PASSWORD="alpha beta gamma', `PASSWORD=${REDACTED}`],
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

// A quoted value ends on its own line. A closing quote is never looked for on
// a later line: with two truncated values in a row, the second value's opening
// quote would close the first, and the second value would survive.
// The Bearer pass must leave the closing quote of the JSON string it was in,
// or the next field's quotes pair up wrongly and its value survives.
describe("adjacent JSON fields with secret names", () => {
  test.each([
    [
      '{"password":"Bearer abcdefgh1234","api_key":"hunter2xyz"}',
      `{"password":"${REDACTED}","api_key":${REDACTED}}`,
    ],
    [
      '{"token":"Bearer abcdefgh1234","password":"hunter2xyz","a":1}',
      `{"token":"${REDACTED}","password":${REDACTED},"a":1}`,
    ],
    ['{"password":"aaa","secret":"bbb"}', `{"password":${REDACTED},"secret":${REDACTED}}`],
  ])("%s → %s", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 2 });
  });
});

// The MCP server's names that may be written with a space (`api key`,
// `access token`, `client secret`, `secret access key`, …), as fixed phrases.
// The name stays.
describe("names with spaces", () => {
  test.each([
    ["api key: plainvalue123", `api key: ${REDACTED}`],
    ["API KEY=plainvalue123", `API KEY=${REDACTED}`],
    ["my api key: plainvalue123", `my api key: ${REDACTED}`],
    ["secret key: plainvalue123", `secret key: ${REDACTED}`],
    ["secret access key: plainvalue123", `secret access key: ${REDACTED}`],
    ["client secret: plainvalue123", `client secret: ${REDACTED}`],
  ])("%s → %s", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });

  // Only those phrases have spaces: other words before a separator are not
  // part of a name, so a value elsewhere on the line is not taken.
  test.each([["invalid token for user_id=user_123"], ["token and limit=5"], ["primary key: id"]])(
    "%s is left alone",
    (input) => {
      expect(redact(input)).toEqual({ text: input, redactions: 0 });
    },
  );
});

// A separator never crosses a line break, so a YAML parent cannot take its
// child's name as its value; a child whose own name is secret-looking still
// loses its value.
describe("a value never starts on a later line", () => {
  test.each([
    ["auth:\n  password: hunter2", `auth:\n  password: ${REDACTED}`],
    ["secrets:\n  db_password: hunter2pass", `secrets:\n  db_password: ${REDACTED}`],
  ])("%j → %j", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });

  test.each([
    ["password:\nnext: 1"],
    ["api_key=\nnext=1"],
    ["Token refresh fails:\n  run clerk auth login"],
  ])("%j is left alone", (input) => {
    expect(redact(input)).toEqual({ text: input, redactions: 0 });
  });
});

describe("a quoted value never continues past its line", () => {
  test.each([
    ['password="abc\npassword="def', `password=${REDACTED}\npassword=${REDACTED}`],
    ['{"password":"abc\n{"password":"def', `{"password":${REDACTED}\n{"password":${REDACTED}`],
    [
      '{\\"password\\":\\"abc\n{\\"password\\":\\"def',
      `{\\"password\\":${REDACTED}\n{\\"password\\":${REDACTED}`,
    ],
  ])("%s → %s", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 2 });
  });

  // Pinned limit: a quoted value that really does span lines keeps its later
  // lines. Private key blocks, the one multi-line secret that is common, are
  // taken whole by their own pass first.
  test("the second line of a multi-line quoted value survives", () => {
    expect(redact('DB_PASSWD="line one\nline two"')).toEqual({
      text: `DB_PASSWD=${REDACTED}\nline two"`,
      redactions: 1,
    });
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

// A bare value stops at the first whitespace or double quote, so the rest of a
// one-line JSON object or log line survives the assignment inside it.
describe("the rest of a one-line log survives", () => {
  test.each([
    [
      '{"message":"password: must be 8 chars","code":"weak_password","status":422}',
      `{"message":"password: ${REDACTED} be 8 chars","code":"weak_password","status":422}`,
    ],
    [
      'level=error msg="auth: token expired" user=bob request_id=abc',
      `level=error msg="auth: ${REDACTED} expired" user=bob request_id=abc`,
    ],
    [
      "Error: token: invalid, then I tried clerk whoami and it worked",
      `Error: token: ${REDACTED} then I tried clerk whoami and it worked`,
    ],
    ['{"note":"token=abc","next":"x"}', `{"note":"token=${REDACTED}","next":"x"}`],
    ['note="set token=abc" next=1', `note="set token=${REDACTED}" next=1`],
  ])("%j → %j", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });
});

describe("emails inside brackets", () => {
  test.each([
    ["user [john@example.com] logged in", `user [${EMAIL_MARKER}] logged in`, 1],
    ["[jane.doe@corp.io](mailto:jane.doe@corp.io)", `[${EMAIL_MARKER}](mailto:${EMAIL_MARKER})`, 2],
    ["[REDACTED]@example.com", "[REDACTED]@example.com", 0],
    ["https://alice:pw@example.com/x", `https://${REDACTED}@example.com/x`, 1],
  ])("%j → %j", (input, expected, count) => {
    expect(redact(input)).toEqual({ text: expected, redactions: count });
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
    [`${HOME}-old/app`],
    [`${HOME}.bak/app`],
    [`${HOME}_2/app`],
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
// A home under /Users is also caught by the generic pass, so a longer name
// that starts with the current user's is taken whole, never as `~-old`.
test.each([
  ["/Users/shane-old/app", "~/app"],
  ["/Users/shane.bak/app", "~/app"],
  ["/Users/shane/app", "~/app"],
])("with home /Users/shane, %s → %s", (input, expected) => {
  expect(redactText(input, { homedir: "/Users/shane" })).toEqual({ text: expected, redactions: 1 });
});

test.each([
  ["cd /root.", "/root", "cd ~."],
  ["(/opt/homes/shane)", "/opt/homes/shane", "(~)"],
  ["(/srv/alice)", "/srv/alice", "(~)"],
  ["see /srv/alice, then retry", "/srv/alice", "see ~, then retry"],
  ["[/srv/alice]", "/srv/alice", "[~]"],
  ["/srv/alice", "/srv/alice", "~"],
  ["/srv/alice/app", "/srv/alice", "~/app"],
])(
  "punctuation after the home directory is a boundary: %s (home %s) → %s",
  (input, home, expected) => {
    expect(redactText(input, { homedir: home })).toEqual({ text: expected, redactions: 1 });
  },
);

// When the value after a secret-looking name is a Bearer or Basic scheme, the
// token after it goes too, whatever it looks like.
describe("a scheme word as the value of a secret-looking name", () => {
  test.each([
    ["token: Bearer xyz", `token: ${REDACTED}`],
    ["TOKEN=Bearer x7k2", `TOKEN=${REDACTED}`],
    ["token: Bearer abcdefghij", `token: ${REDACTED}`],
    ["token: Bearer xyz then retried", `token: ${REDACTED} then retried`],
    ["password: basic hunter", `password: ${REDACTED}`],
    ["--token Bearer abcdefghij next", `--token ${REDACTED} next`],
  ])("%j → %j", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });
});

// An Authorization header inside a quoted string (curl's -H) ends at the
// string's closing quote, and the rest of the command survives.
describe("an Authorization header inside a quoted string", () => {
  test.each([
    [
      'curl -H "Authorization: Bearer abcdefghijklmnop" https://api.clerk.com/v1/users',
      `curl -H "Authorization: ${REDACTED}" https://api.clerk.com/v1/users`,
    ],
    ["curl -H 'Authorization: token abc123' -X GET", `curl -H 'Authorization: ${REDACTED}' -X GET`],
    [
      'curl -H \\"Authorization: token abc123\\" -X GET',
      `curl -H \\"Authorization: ${REDACTED}\\" -X GET`,
    ],
  ])("%j → %j", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });

  // After a quoted header, an unquoted one later on the same line is still read.
  test("an unquoted header after a quoted one on the same line is taken too", () => {
    expect(
      redact(
        'curl -H "Authorization: Bearer abcdefghijklmnop" url; echo Authorization: token ghx12345',
      ),
    ).toEqual({
      text: `curl -H "Authorization: ${REDACTED}" url; echo Authorization: ${REDACTED}`,
      redactions: 2,
    });
  });

  // In a string delimited by a plain quote, only an unescaped quote ends the
  // value; in escaped JSON, delimited by \", the escaped quote ends it.
  test("an escaped quote inside a double-quoted header does not end its value", () => {
    expect(
      redact('"Authorization: Digest username=\\"bob\\", response=\\"secret123\\"" next'),
    ).toEqual({
      text: `"Authorization: ${REDACTED}" next`,
      redactions: 1,
    });
  });

  test("in escaped JSON the escaped quote ends the header value", () => {
    expect(redact('{\\"msg\\": \\"Authorization: token abc123\\", \\"n\\": 1}')).toEqual({
      text: `{\\"msg\\": \\"Authorization: ${REDACTED}\\", \\"n\\": 1}`,
      redactions: 1,
    });
  });

  test("two quoted headers on one line are both taken", () => {
    expect(
      redact('curl -H "Authorization: token a1b2" -H "Authorization: token c3d4" -X GET'),
    ).toEqual({
      text: `curl -H "Authorization: ${REDACTED}" -H "Authorization: ${REDACTED}" -X GET`,
      redactions: 2,
    });
  });
});

// Other users' homes: Git Bash and WSL spellings of a Windows home, the
// forward-slash Windows form, and punctuation after the user name.
describe("home directories in other spellings", () => {
  test.each([
    ["/c/Users/bob/project/app.ts", "~/project/app.ts"],
    ["/mnt/c/Users/bob/project", "~/project"],
    ["C:/Users/bob/project", "~/project"],
    ["see /Users/bob.", "see ~."],
    ["(/Users/bob)", "(~)"],
    ["see /home/bob, then", "see ~, then"],
    ["/Users/john.doe/app", "~/app"],
    ["/home/jos\u00e9/app", "~/app"],
    // Combining marks are part of a name: a Devanagari name, and decomposed accents.
    ["C:\\Users\\\u092A\u094D\u0930\u093F\u092F\u093E\\project", "~\\project"],
    ["/Users/ana\u0301-maria/project", "~/project"],
    ["/home/jose\u0301.dupont/app", "~/app"],
  ])("%j → %j", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });
});

// Two-character assignment operators from other languages: Go's :=, Ruby
// and PHP's =>, and comparisons (== and ===).
describe("assignment operators from other languages", () => {
  test.each([
    ['password := "hunter2"', `password := ${REDACTED}`],
    ["'password' => 'hunter2'", `'password' => ${REDACTED}`],
    ["password == hunter2", `password == ${REDACTED}`],
    ['if (token === "abc123") {', `if (token === ${REDACTED}) {`],
  ])("%j → %j", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });
});

// Clerk machine tokens: M2M tokens (`mt_`) and OAuth access tokens (`oat_`),
// built at runtime. Short identifiers with the same prefix are left alone.
describe("Clerk machine tokens", () => {
  const OAT = ["oat_", "abcdefghijklmnop"].join("");
  const MT = ["mt_", "abcdefghijklmnopqrstu"].join("");
  test.each([
    [`token ${OAT} rejected`, `token ${REDACTED} rejected`],
    [`m2m ${MT} rejected`, `m2m ${REDACTED} rejected`],
  ])("%j → %j", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });

  test.each([["mt_rand(1, 6)"], ["oat_milk is better"], ["call mt_getrandmax()"]])(
    "%j is left alone",
    (input) => {
      expect(redact(input)).toEqual({ text: input, redactions: 0 });
    },
  );
});

// Clerk's dev-browser token (the `__clerk_db_jwt` value in development):
// `dvb_` and an id, 27 letters and digits, or 64 hex digits in older ones.
// Made-up values of the real shapes, assembled at runtime.
describe("Clerk dev-browser tokens", () => {
  const DVB = ["dvb_", "2nFq8LmW4xRtY6pZ0aKcVb3HsJe"].join("");
  const DVB_HEX = ["dvb_", "9f2c4e6a8b0d1f3e5a7c9b1d3f5e7a9c0b2d4f6e8a1c3e5b7d9f0a2c4e6b8d1f"].join(
    "",
  );
  test.each([
    [`dev browser ${DVB} expired`, `dev browser ${REDACTED} expired`],
    [`dev browser ${DVB_HEX} expired`, `dev browser ${REDACTED} expired`],
    [`https://x.dev/?__clerk_db_jwt=${DVB}&a=1`, `https://x.dev/?__clerk_db_jwt=${REDACTED}&a=1`],
  ])("%j → %j", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });

  test("a value of 27 characters is the real length", () => {
    expect(DVB.length - "dvb_".length).toBe(27);
  });

  test.each([["dvb_short"], ["the dvb_ prefix"]])("%j is left alone", (input) => {
    expect(redact(input)).toEqual({ text: input, redactions: 0 });
  });
});

// More secret words, with the same joiners as API_KEY: `_` or `-`, nothing in
// camelCase, a space inside a quoted JSON name.
describe("CREDENTIAL, ACCESS_KEY, SIGNING_KEY and SESSION_KEY", () => {
  test.each([
    ["DB_CREDENTIAL=plainvalue1", `DB_CREDENTIAL=${REDACTED}`],
    ["GOOGLE_CREDENTIALS: plainvalue1", `GOOGLE_CREDENTIALS: ${REDACTED}`],
    ["AWS_ACCESS_KEY=plainvalue1", `AWS_ACCESS_KEY=${REDACTED}`],
    ["awsAccessKey=plainvalue1", `awsAccessKey=${REDACTED}`],
    ["JWT_SIGNING_KEY=plainvalue1", `JWT_SIGNING_KEY=${REDACTED}`],
    ['"signingKey": "plainvalue1"', `"signingKey": ${REDACTED}`],
    ['"signing key": "plainvalue1"', `"signing key": ${REDACTED}`],
    ["SESSION_KEY=plainvalue1", `SESSION_KEY=${REDACTED}`],
    ["--session-key plainvalue1", `--session-key ${REDACTED}`],
  ])("%j → %j", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });

  test.each([["session started"], ["access granted, key rotated"], ["signing in"]])(
    "%j is left alone",
    (input) => {
      expect(redact(input)).toEqual({ text: input, redactions: 0 });
    },
  );
});

// curl's `-u`/`--user` takes `user:password`; the whole value goes. Only on a
// line that runs curl, so `docker run -u 1000:1000` keeps its ids, and only
// with a colon: without one, curl asks for the password.
describe("curl user credentials", () => {
  test.each([
    ["curl -u alice:hunter2 https://x.dev", `curl -u ${REDACTED} https://x.dev`],
    ["curl --user alice:hunter2 https://x.dev", `curl --user ${REDACTED} https://x.dev`],
    ["curl --user=alice:hunter2 https://x.dev", `curl --user=${REDACTED} https://x.dev`],
    ["curl -ualice:hunter2 https://x.dev", `curl -u${REDACTED} https://x.dev`],
    ['curl -s -u "alice:correct horse" https://x.dev', `curl -s -u ${REDACTED} https://x.dev`],
    [
      "$ sudo curl -X POST -u bob:pw https://x.dev",
      `$ sudo curl -X POST -u ${REDACTED} https://x.dev`,
    ],
    // A user name that is already the marker still has a password after it.
    [`curl -u ${REDACTED}:hunter2 https://x.dev`, `curl -u ${REDACTED} https://x.dev`],
  ])("%j → %j", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });

  test.each([
    ["docker run -u 1000:1000 node"],
    ["curl -u alice https://x.dev"],
    ["curl --user-agent a:b https://x.dev"],
    // curl on an earlier line does not reach a later one.
    ["curl https://x.dev\ndocker run -u 1000:1000 node"],
  ])("%j is left alone", (input) => {
    expect(redact(input)).toEqual({ text: input, redactions: 0 });
  });
});

// Cookie headers carry session tokens: treated like Authorization.
describe("Cookie and Set-Cookie headers", () => {
  test.each([
    ["Cookie: __client=abcdefghijklmnop1234", `Cookie: ${REDACTED}`],
    ["Set-Cookie: __session=abc123; Path=/", `Set-Cookie: ${REDACTED}`],
    ['curl -H "Cookie: __client=abc123" https://x', `curl -H "Cookie: ${REDACTED}" https://x`],
  ])("%j → %j", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });
});

// Short password names, as whole segments of a name.
describe("PASS and PWD as secret words", () => {
  test.each([
    ["DB_PASS=hunter2", `DB_PASS=${REDACTED}`],
    ["MYSQL_PWD=x", `MYSQL_PWD=${REDACTED}`],
    ["pwd=hunter2", `pwd=${REDACTED}`],
    ["pass: hunter2", `pass: ${REDACTED}`],
    ["--pass hunter2", `--pass ${REDACTED}`],
  ])("%j → %j", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });

  // A camelCase segment counts too; lowercase words that contain the letters
  // do not.
  test.each([
    ["dbPass=hunter2", `dbPass=${REDACTED}`],
    ["dbPwd=hunter2", `dbPwd=${REDACTED}`],
    ["userPwd=hunter2", `userPwd=${REDACTED}`],
    ["clientAuth: abc123", `clientAuth: ${REDACTED}`],
    ['{"dbPass": "hunter2", "n": 1}', `{"dbPass": ${REDACTED}, "n": 1}`],
    ["dbPASS=hunter2", `dbPASS=${REDACTED}`],
    ["--dbPass hunter2", `--dbPass ${REDACTED}`],
    ["--dbPwd hunter2", `--dbPwd ${REDACTED}`],
    ["--clientAuth abc123", `--clientAuth ${REDACTED}`],
    ["--dbPass=hunter2", `--dbPass=${REDACTED}`],
    ["mysql --dbPass hunter2 --host db", `mysql --dbPass ${REDACTED} --host db`],
    // One shell word, through any quoted part, as for any other flag.
    ['--dbPass "correct horse" --host db', `--dbPass ${REDACTED} --host db`],
  ])("camelCase %j → %j", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });

  test.each([
    ["bypass=1"],
    ["compass=north"],
    ["isPassed=true"],
    ["clientAuthor=alice"],
    ["myAUTHOR=alice"],
    ["--bypass hunter2"],
    ["--isPassed true"],
    ["--clientAuthor alice"],
    // A flag followed by another flag has no value.
    ["--dbPass --host db"],
  ])("camelCase lookalike %j is left alone", (input) => {
    expect(redact(input)).toEqual({ text: input, redactions: 0 });
  });

  // Ordinary words that contain the letters, and the shell's working
  // directory (a path is not a password).
  test.each([
    ["tests passed: 4"],
    ["bypass=1"],
    ["compass=north"],
    ["PWD=/srv/app"],
    ["OLDPWD=/srv/app"],
  ])("%j is left alone", (input) => {
    expect(redact(input)).toEqual({ text: input, redactions: 0 });
  });
});

describe("known limitations", () => {
  // Best-effort by design: these are the shapes the scrubber does not understand.
  test("a password attached to mysql's -p keeps the password", () => {
    expect(redact("mysql -u root -pS3cretPw db")).toEqual({
      text: "mysql -u root -pS3cretPw db",
      redactions: 0,
    });
  });

  // Over-matches in the safe direction: a name containing CREDENTIAL that
  // holds no secret loses its value too.
  test.each([
    ['fetch(url, { credentials: "include" })', `fetch(url, { credentials: ${REDACTED} })`],
    ["git config credential.helper=store", `git config credential.helper=${REDACTED}`],
    [
      "curl -s https://x.dev | docker run -u 1000:1000 node",
      `curl -s https://x.dev | docker run -u ${REDACTED} node`,
    ],
  ])("over-match %j → %j", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redactions: 1 });
  });

  test("a password with spaces keeps every word after the first", () => {
    expect(redact("DB_PASSWORD=correct horse battery staple")).toEqual({
      text: `DB_PASSWORD=${REDACTED} horse battery staple`,
      redactions: 1,
    });
  });

  test("a password with a double quote in it keeps the part from the quote", () => {
    expect(redact('then password=abc"def ghi" ran')).toEqual({
      text: `then password=${REDACTED}"def ghi" ran`,
      redactions: 1,
    });
  });

  test.each([
    // A YAML block scalar: only the indicator is taken.
    ["password: |\n  hunter2", `password: ${REDACTED}\n  hunter2`],
    // A YAML child whose own name does not look secret.
    ["tokens:\n  clerk: plainvalue123", "tokens:\n  clerk: plainvalue123"],
    // Nested JSON: only the first inner value goes with the object's start.
    [
      '{"secrets":{"db":"first-secret","api":"second-secret"}}',
      `{"secrets":${REDACTED},"api":"second-secret"}}`,
    ],
    // Pretty-printed JSON: the lines below the key are not read as its value.
    [
      '"secrets": {\n  "db": "first-secret"\n}',
      `"secrets": ${REDACTED}\n  "db": "first-secret"\n}`,
    ],
  ])("a value in a structured config file is not followed: %j", (input, expected) => {
    expect(redact(input).text).toBe(expected);
  });

  test("a label wrapped in Markdown formatting keeps its value", () => {
    expect(redact("**Password**: hunter2")).toEqual({
      text: "**Password**: hunter2",
      redactions: 0,
    });
  });

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
      text: `set the Authorization: ${REDACTED}\nthen retry`,
      redactions: 1,
    });
  });

  test("a home directory whose user name contains a space keeps the second word", () => {
    expect(redact("/Users/John Smith/app/x.ts")).toEqual({
      text: "~ Smith/app/x.ts",
      redactions: 1,
    });
  });

  // Two truncated quoted values on one line: the second's opening quote closes
  // the first, and the second value survives. One truncated value per line is
  // what a truncated log produces, and that case is covered above.
  test("the second of two unterminated quoted values on one line survives", () => {
    const { text } = redact('{"password":"abc {"password":"def');
    expect(text).toBe(`{"password":${REDACTED}password":"def`);
  });
});

/**
 * Every pass is linear by construction (see the module comment); these tests
 * are the backstop. Most shapes are ones that made an earlier version of a
 * pass rescan the text from every candidate position; the rest probe the
 * newer patterns the same way. A quadratic pass takes four
 * times as long when the input doubles; a linear one about twice. The ratio
 * is checked only when the smaller run took long enough to time (a run under
 * a few milliseconds is noise), and the 1 MB run must also finish well under
 * a second on a busy machine.
 */
describe("large pastes stay linear", () => {
  const NAME_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function blob(size: number): string {
    let out = "";
    for (let i = 0; i < size; i++) out += NAME_CHARS[(i * 7919) % NAME_CHARS.length];
    return out;
  }
  const MB = 1_048_576;
  const fill = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length));
  const urlHeavyJson = (size: number) =>
    "[" +
    Array.from(
      { length: Math.ceil(size / 36) },
      (_, i) => `{"u":"http://localhost:3000/p/${i}"}`,
    ).join(",") +
    "]";

  const SHAPES: Array<[string, (size: number) => string]> = [
    ["run of name characters with no secret word", blob],
    ["run of a secret word with no separator", (n) => fill("token", n)],
    ["run of a secret word followed by one separator", (n) => fill("token", n) + "=x"],
    ["dotted run", (n) => fill("a.", n)],
    ["dashed run", (n) => fill("a-", n)],
    ["dashes before eyJ", (n) => fill("-eyJ", n)],
    ["flag run with no value", (n) => fill("--token ", n)],
    ["one long flag name", (n) => "--" + fill("token-", n)],
    ["unterminated quoted value on every line", (n) => fill('password="abc,def\n', n)],
    ["unterminated escaped quoted value on every line", (n) => fill('{\\"password\\":\\"abc\n', n)],
    ["quoted names with no separator", (n) => fill('"password" ', n)],
    ["one-line JSON holding URLs", urlHeavyJson],
    ["scheme fragments in one token", (n) => fill("a://b:", n)],
    ["BEGIN markers with no END", (n) => fill("-----BEGIN PRIVATE KEY-----\nMIIabc\n", n)],
    ["BEGIN followed by a long header line", (n) => "-----BEGIN " + fill("x", n)],
    [
      "BEGIN header repeating PRIVATE KEY with no closing dashes",
      (n) => "-----BEGIN " + fill("PRIVATE KEY ", n),
    ],
    [
      "END header repeating PRIVATE KEY inside a block",
      (n) => "-----BEGIN PRIVATE KEY-----\nabc\n-----END " + fill("PRIVATE KEY ", n),
    ],
    ["spaced name words with no separator", (n) => fill("my api ", n)],
    ["a line of spaces ending in a colon", (n) => "token" + fill(" ", n) + ":"],
    ["colon assignments repeated on one line", (n) => fill("token: a ", n)],
    ["equals assignments repeated mid-line", (n) => "x " + fill("token=a ", n)],
    ["quotes only", (n) => fill('"', n)],
    ["escaped quotes only", (n) => fill('\\"', n)],
    ["home paths", (n) => fill("/Users/alice/x ", n)],
    ["quoted Authorization headers on one line", (n) => fill('"Authorization: ', n)],
    ["escaped quotes inside a quoted header", (n) => '"Authorization: ' + fill('\\"x ', n)],
    ["combining marks in a user name", (n) => "/Users/a" + fill("\u0301", n)],
    ["Git Bash home prefixes repeated", (n) => fill("/c/Users/", n)],
    ["a dotted user name after a home prefix", (n) => "/Users/" + fill("a.", n)],
    ["scheme words after secret names", (n) => fill("token: Bearer ", n)],
    ["a camelCase secret word repeated with no separator", (n) => fill("dbPass", n)],
    ["camelCase secret names each without a separator", (n) => fill("aPass ", n)],
    ["camelCase flag run with no value", (n) => fill("--dbPass ", n)],
    ["dev-browser prefixes too short to be tokens", (n) => fill("dvb_abc ", n)],
    ["a CREDENTIAL word repeated with no separator", (n) => fill("credential", n)],
    ["curl repeated with a user flag and no value", (n) => fill("curl -u ", n)],
    ["curl user flags without a colon on one line", (n) => "curl " + fill("-u a ", n)],
    ["curl with an unterminated quoted user", (n) => 'curl -u "' + fill("a:", n)],
    ["curl words with no user flag", (n) => fill("curl x ", n)],
    ["one long camelCase flag name", (n) => "--" + fill("dbPass-", n)],
    ["Authorization headers on one line", (n) => fill("Authorization: ", n)],
    ["Bearer words", (n) => fill("Bearer ", n)],
    ["a run of dots inside a Bearer token", (n) => "Bearer a" + fill(".", n) + "a"],
    ["email local part with no domain", (n) => fill("a.", n) + "@"],
    ["email domain with no top-level domain", (n) => "a@" + fill("b.", n)],
    ["minified JSON log", (n) => fill('{"level":"info","user":"bob","n":1},', n)],
    ["literal \\n escapes between assignments", (n) => fill("a\\npassword=x%20", n)],
  ];

  const timed = (input: string): number => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      redact(input);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };

  test.each(SHAPES)(
    "%s: 1 MB finishes well under a second, and doubling at most triples the time",
    (_label, shape) => {
      const half = timed(shape(MB / 2));
      const full = timed(shape(MB));
      expect(full).toBeLessThan(1000);
      if (half >= 5) expect(full / half).toBeLessThan(3);
    },
  );
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

  // Scrubbing sees the whole field, so a secret that starts inside the cap
  // and runs far past it is matched whole, however long it is.
  test("a quoted value that runs far past the cap is fully redacted", () => {
    const padding = "x".repeat(CAP - 21);
    const input = `${padding} DB_PASSWD="${"s".repeat(10 * CAP)}`;
    expect(capped(input)).toEqual({ text: `${padding} DB_PASSWD=${REDACTED}`, redactions: 1 });
  });

  test("a private key block that runs far past the cap is fully redacted", () => {
    const body = "A".repeat(10 * CAP);
    const input = `${"x".repeat(CAP - 50)}-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    expect(capped(input)).toEqual({ text: `${"x".repeat(CAP - 50)}${REDACTED}`, redactions: 1 });
  });

  // The whole field is scrubbed before the cut, so a secret beyond the cap is
  // counted even though the cut then removes it: the count describes the
  // field as pasted.
  test("a secret beyond the cap is counted, and the output is still cut at the cap", () => {
    const { text, redactions } = capped("x".repeat(5 * CAP) + " sk_test_abc123");
    expect(redactions).toBe(1);
    expect(text).toBe("x".repeat(CAP));
  });

  // A token that starts just inside the cap is matched whole because nothing
  // is cut before scrubbing, whatever earlier redactions did to the length.
  test("a token that straddles the cap never reaches the output, whatever earlier redactions shrank", () => {
    const key = ["sk_test_", "a".repeat(92)].join("");
    const token = ["ghp_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("");
    const keys = Array.from({ length: 100 }, () => key).join(" ");
    // After the keys shrink to markers, the token starts 14 characters before the cap.
    const scrubbedKeysLength = 100 * REDACTED.length + 99;
    const filler = "x".repeat(CAP - 14 - scrubbedKeysLength - 2);
    const input = `${keys} ${filler} ${token} tail`;
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

  test("a quoted value with an escaped quote that runs far past the cap is fully redacted", () => {
    const padding = "x".repeat(CAP - 21);
    const input = `${padding} DB_PASSWD="al\\"pha${"s".repeat(10 * CAP)}" tail`;
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
    ["--db-password=plain_value_888 next", `--db-password=${REDACTED} next`],
    ["--api_key abc123secretvalue next", `--api_key ${REDACTED} next`],
    ["--client_secret abc123secretvalue next", `--client_secret ${REDACTED} next`],
    ["--db_password=abc123secretvalue next", `--db_password=${REDACTED} next`],
    ["--secret-key=sk_test_abc123 next", `--secret-key=${REDACTED} next`],
    ["--db-encryption-key=plain_value_888 next", `--db-encryption-key=${REDACTED} next`],
    // The value is a whole shell word, through any quoted part it contains.
    ['--token MY_TOKEN="alpha beta" next', `--token ${REDACTED} next`],
    ['--password "alpha beta"gamma next', `--password ${REDACTED} next`],
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

// A literal `\n` or `\t` (escaped text), a URL-encoded character or an ANSI
// color code ends in a letter or digit, which would otherwise hide the next
// word's start.
describe("secrets right after an escape sequence", () => {
  const BEARER_TOKEN = "abcdefghijklmnopqrstuvwxyz123456";
  test.each([
    [
      "Clerk key after a literal \\n",
      `{"msg":"line one\\n${"sk_live_"}abc123def456"}`,
      "abc123def456",
    ],
    ["JWT after a literal \\n", `"x\\n${JWT}"`, JWT],
    ["Bearer token after a literal \\n", `"h\\nBearer ${BEARER_TOKEN}"`, BEARER_TOKEN],
    ["password after a literal \\t", `"x\\tpassword=hunter2xyz"`, "hunter2xyz"],
    ["curl -u after a literal \\n", `"x\\ncurl -u bob:s3cretpw https://x.io"`, "s3cretpw"],
    ["home path after a literal \\n", `"x\\n/Users/alice/app"`, "alice"],
    ["Clerk key after %20", `q=x%20${"sk_live_"}abc123def456`, "abc123def456"],
    ["Clerk key after %3D", `q=x%26key%3D${"sk_live_"}abc123def456`, "abc123def456"],
    ["Clerk key after %22", `q=%22${"sk_live_"}abc123def456%22`, "abc123def456"],
    ["Clerk key after a lowercase %2c", `a=1%2c${"sk_live_"}abc123def456`, "abc123def456"],
    [
      "Clerk key inside an ANSI color code",
      `\x1b[31m${"sk_live_"}abc123def456\x1b[0m`,
      "abc123def456",
    ],
  ])("%s", (_label, input, secret) => {
    const { text, redactions } = redact(input);
    expect(text).not.toContain(secret);
    expect(redactions).toBeGreaterThan(0);
  });

  test("the escape sequences themselves survive", () => {
    expect(redact(`a\\nsk_live_abc123def456\\tb%20c%3Dd`).text).toBe(`a\\n${REDACTED}\\tb%20c%3Dd`);
  });
});

// Bun's regex engine gives up on a long run without an error and reports no match.
describe("a secret followed by a long run", () => {
  test.each([
    ["URL query", (tail: string) => `password=hunter2xyz&data=${tail}`],
    ["flag", (tail: string) => `--token hunter2xyz${tail}`],
    ["JSON field", (tail: string) => `{"password":"hunter2xyz","data":"${tail}"}`],
    ["camelCase name", (tail: string) => `dbPass=hunter2xyz${tail}`],
  ])("%s", (_label, shape) => {
    for (const size of [10_000, 60_000, 200_000]) {
      expect(redact(shape("a".repeat(size))).text).not.toContain("hunter2xyz");
    }
  });
});

// The same engine limit, inside the value: a quoted value as long as a field
// may be is still taken whole.
describe.each([
  ["double-quoted", (value: string) => `password="${value}"`, `password=${REDACTED}`],
  ["single-quoted", (value: string) => `password='${value}'`, `password=${REDACTED}`],
  ["unterminated", (value: string) => `password="${value}`, `password=${REDACTED}`],
  [
    "escaped JSON",
    (value: string) => `{\\"password\\":\\"${value}\\"}`,
    `{\\"password\\":${REDACTED}}`,
  ],
  ["JSON field", (value: string) => `{"apiToken": "${value}"}`, `{"apiToken": ${REDACTED}}`],
  ["camelCase name", (value: string) => `dbPass="${value}"`, `dbPass=${REDACTED}`],
])("a long %s value", (_label, shape, expected) => {
  test.each([60_000, 200_000, FEEDBACK_FIELD_MAX_LENGTH])("%d characters", (size) => {
    expect(redact(shape(`hunter2xyz${"a".repeat(size)}`))).toEqual({
      text: expected,
      redactions: 1,
    });
  });
});
