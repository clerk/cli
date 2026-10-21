/**
 * Client-side scrubbing for the free text `clerk feedback` sends.
 *
 * Scrubbing is best-effort. It catches secrets by their shape: keys and
 * tokens with known prefixes, private key blocks, `Authorization` headers and
 * Bearer or Basic tokens, credentials in URLs, and a value assigned to a
 * secret-looking name on one line (`CLERK_SECRET_KEY=…`, `password: …`,
 * `--token …`), and curl's `-u user:password`. It also replaces email addresses and home-directory paths.
 * It does not understand structure, so it misses values that span lines,
 * values in structured config files (YAML blocks, pretty-printed JSON),
 * passwords with spaces in them, and labels wrapped in Markdown formatting
 * (`**Password**: …`). Never include secrets in a report.
 *
 * Every free-text field passes through {@link redactAndCap}: the whole field
 * is scrubbed, then cut to its cap, so a secret is never split into a
 * fragment no pattern recognises. The command refuses a field over its
 * ceiling, and every pass is linear in the size of its input, so the cost of
 * a field is bounded by construction.
 *
 * ## The linearity rule
 *
 * A match attempt that fails costs work bounded by a constant, or by text
 * that the next successful match consumes, and no position inside a run is
 * tried as a start:
 *
 * - A start is pinned by a literal (`-----BEGIN`, `Authorization`, a key
 *   prefix) or by a lookbehind that refuses to start inside a run of name
 *   characters.
 * - A run of name characters is taken atomically: a lookahead captures the
 *   whole run and a backreference consumes it, so a later failure cannot make
 *   the engine retry every shorter prefix. The run is tested once for a
 *   secret-looking word.
 * - A quoted value ends on its line; a quote with no partner on its line takes
 *   the rest of the line, so the engine never scans ahead for a partner.
 * - A URL password is bounded ({@link URL_PASSWORD_MAX_LENGTH}), because it
 *   may contain `/`, `:` and `@` and so has no delimiter to stop at.
 * - A private key block with no END line runs to the end of the text in the
 *   same scan, and the words of a BEGIN or END header are bounded.
 *
 * The timing tests in `redact.test.ts` are the backstop: each adversarial
 * shape runs at half a megabyte and at one megabyte, and the larger run must
 * finish in under a second and take less than three times as long as the
 * smaller (linear time about doubles; quadratic time quadruples).
 *
 * ## The passes, in order
 *
 * 1. Private key blocks, to the matching END line or the end of the text, PGP
 *    included. First because they span lines.
 * 2. `Authorization`, `Cookie` and `Set-Cookie` headers, any scheme: the rest of the line, the quoted
 *    value when the header is a JSON field, or up to the closing quote when
 *    the header starts inside a quoted string (`curl -H "Authorization: …"`). Before the name pass, which would
 *    take only the first word (`Bearer`).
 * 3. `Bearer` and `Basic` tokens in prose, with guards that keep the ordinary
 *    words out. Before the name pass so `token: Bearer xyz` loses `xyz`.
 * 4. Name and value, keeping the name: `--flag value` and `--flag=value`
 *    (one shell word), `"name": value` (a JSON field: a quoted value, or an
 *    unquoted one up to `,`, `;` or `}`), and bare `NAME=value` or
 *    `name: value` (a quoted value, or an unquoted one up to the first
 *    whitespace or double quote, so the rest of a one-line log survives). A
 *    name is secret-looking when it contains a secret word (`SECRET`,
 *    `TOKEN`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, `API_KEY`, `PRIVATE_KEY`,
 *    `ENCRYPTION_KEY`, `ACCESS_KEY`, `SIGNING_KEY`, `SESSION_KEY`,
 *    `AUTHORIZATION`, or `AUTH`, `PASS` or `PWD` as a whole
 *    segment, camelCase included (`dbPass`, `clientAuth`); the shell's
 *    `PWD=/path` is left alone) or is
 *    one of the MCP server's spaced names (`api key`, `access token`,
 *    `refresh token`, `auth token`, `client secret`, `secret key`,
 *    `secret access key`). The separator may also be `:=`, `=>`, `==` or
 *    `===`. A value that is a `Bearer` or `Basic` scheme takes
 *    the token after it too. No separator crosses a line break. Then, on a
 *    line that runs `curl`, the value of `-u` or `--user` when it holds a
 *    colon (`user:password`), whole; only on such a line, so
 *    `docker run -u 1000:1000` keeps its ids.
 * 5. Known key prefixes: the MCP server's list, then the CLI's `ak_`
 *    Platform API keys, Clerk M2M (`mt_`) and OAuth access (`oat_`) tokens,
 *    Clerk dev-browser tokens (`dvb_`), and `sk-` keys (OpenAI, Anthropic). After the name
 *    pass so a value already replaced is not counted twice.
 * 6. Credentials in URLs (`scheme://user:password@host`): the credential
 *    goes, scheme and host stay.
 * 7. Home directories: the current user's own home first (ending at any
 *    character that cannot continue a user name), then the generic
 *    `/Users/<name>`, `/home/<name>` and `C:\Users\<name>` forms (also
 *    `C:/Users`, Git Bash's `/c/Users` and WSL's `/mnt/c/Users`, and after
 *    `file://`), whose user name likewise stops at punctuation.
 * 8. Email addresses, last, so an address inside a secret already replaced is
 *    not counted twice.
 *
 * ## Relation to the MCP server's redactor
 *
 * Passes 1, 3 and 5 (its prefix list) are a port of the redactor in Clerk's
 * MCP server, pattern for pattern and in its order, and secrets become the
 * same `[REDACTED]` marker so reports from both read the same. Where this
 * module differs, on purpose:
 *
 * - Its `name: value` pattern replaces the name with the value and stops an
 *   unquoted value at a comma. Pass 4 matches every name on its list (each
 *   contains one of the secret words, or is one of its spaced names), keeps
 *   the name, and stops an unquoted bare value at whitespace, so a `.env`
 *   password containing a comma is not half sent.
 * - Its `Authorization: Bearer|Basic <token>` pattern is replaced by pass 2,
 *   which takes any scheme and the whole value.
 * - Pass 3 puts back a closing quote that belongs to the string around the
 *   credential, so the next JSON field still parses.
 * - Pass 1 also matches PGP headers and a block with no END line, and bounds
 *   the header words.
 *
 * ## Known limits, each pinned by a test
 *
 * - What the scrubber does not understand: a value that spans lines, a value
 *   in a YAML block or nested JSON under a secret-looking key, a password
 *   with spaces (`password: correct horse` keeps `horse`), a password with a
 *   double quote in it, a label wrapped in Markdown formatting, and a
 *   password attached to a short flag (`mysql -pS3cret`).
 * - Two truncated quoted values on one line: the second's opening quote
 *   closes the first, and the second value survives.
 * - A URL password longer than {@link URL_PASSWORD_MAX_LENGTH} characters
 *   keeps its username; the email pass still removes the password.
 * - A home directory whose user name contains a space keeps the second word.
 * - Over-matches in the safe direction: any name containing `TOKEN`
 *   (`max_tokens=4096`) or `CREDENTIAL` (fetch's `credentials: "include"`,
 *   git's `credential.helper=store`), a `-u x:y` later on a line that runs
 *   curl even when another command owns it (`curl … | docker run -u 1:1`),
 *   a user segment in a URL with no password
 *   (`https://git@github.com/x`), a URL with a port and an email in its query
 *   string, and prose naming the `Authorization` header, which loses the rest
 *   of its line.
 * - `redactions` counts replacements, one per secret for the common shapes; it
 *   is a "read this report carefully" signal, not a tally.
 */

import { homedir } from "node:os";

export const REDACTED = "[REDACTED]";
export const EMAIL_MARKER = "[EMAIL]";

/**
 * Longest URL password the URL-credential pass catches. A bounded `\S{0,n}`
 * is what keeps that pass linear: an unbounded one rescans to the end of a
 * whitespace-free blob from every `scheme://host:port` fragment.
 */
export const URL_PASSWORD_MAX_LENGTH = 256;

export type Redaction = {
  /** The scrubbed text. */
  text: string;
  /** How many replacements were made, across every kind of pattern. Approximate; see the module comment. */
  redactions: number;
};

// ── Pass 1: private key blocks (port of the MCP server's redactor) ──────────

/**
 * `-----BEGIN <kind> PRIVATE KEY <kind>-----` to the matching END line, or to
 * the end of the text when no END line arrived (a truncated paste). The
 * header allows words on both sides of `PRIVATE KEY` so OpenSSH, RSA,
 * encrypted and PGP (`PGP PRIVATE KEY BLOCK`) headers all match. Those words
 * are bounded (real headers carry a dozen characters or so), which keeps a
 * malformed header linear.
 */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [^\r\n-]{0,40}PRIVATE KEY[^\r\n-]{0,40}-----[\s\S]*?(?:-----END [^\r\n-]{0,40}PRIVATE KEY[^\r\n-]{0,40}-----|$)/gi;

// ── Quoted values, shared by passes 2 and 4 ─────────────────────────────────

/** A closed quoted value on one line; an escaped quote inside it is part of it. */
const QUOTED = String.raw`"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'`;
/** An opening quote with no partner on its line: the value runs to the end of the line. */
const OPEN_QUOTED = String.raw`"(?:\\.|[^"\\\r\n])*\\?(?![^\r\n])|'(?:\\.|[^'\\\r\n])*\\?(?![^\r\n])`;
/**
 * JSON pasted inside a string arrives with its quotes escaped:
 * `{\"password\":\"x\"}`. The value ends at the next `\"`, and a bare `"`
 * cannot occur inside it. Closed and unterminated forms, each on one line.
 */
const ESCAPED_QUOTED = String.raw`\\"(?:[^"\\\r\n]|\\[^"\r\n])*\\"|\\'(?:[^'\\\r\n]|\\[^'\r\n])*\\'`;
const ESCAPED_OPEN_QUOTED = String.raw`\\"(?:[^"\\\r\n]|\\[^"\r\n])*\\?(?![^\r\n])|\\'(?:[^'\\\r\n]|\\[^'\r\n])*\\?(?![^\r\n])`;
/** Every quoted shape, most specific first. */
const ANY_QUOTED = `${ESCAPED_QUOTED}|${ESCAPED_OPEN_QUOTED}|${QUOTED}|${OPEN_QUOTED}`;

// ── Pass 2: Authorization headers ───────────────────────────────────────────

/**
 * A header that starts inside a quoted string (`curl -H "Authorization:
 * Bearer x" https://…`): the value runs to that string's closing delimiter
 * and no further, so the rest of the command, a second header included, is
 * still scanned. In a string opened by a plain quote, an escaped quote is
 * part of the value (a Digest header's `username=\"bob\"`) and only an
 * unescaped quote ends it; in escaped JSON, opened by `\"`, the next `\"`
 * ends it. Not a JSON key: a quote right after the name makes it one, and
 * the general pattern below takes that.
 */
const HEADER_NAME_IN_STRING = String.raw`\b(?:Authorization|Set-Cookie|Cookie)\b(?!["'])[ \t]*[:=][ \t]*`;
const AUTHORIZATION_IN_STRING = new RegExp(
  String.raw`(?:(?<escOpen>\\["'])(?<escName>${HEADER_NAME_IN_STRING})(?<escValue>(?:(?!\k<escOpen>)[^\r\n])*)` +
    String.raw`|(?<open>["'])(?<name>${HEADER_NAME_IN_STRING})(?<value>(?:\\.|(?!\k<open>)[^\\\r\n])*))`,
  "gi",
);

type HeaderInStringGroups = {
  escOpen?: string;
  escName?: string;
  escValue?: string;
  open?: string;
  name?: string;
  value?: string;
};

/**
 * `Authorization: <anything to the end of the line>`, or a quoted value when
 * the header is a JSON field. Any scheme: `Authorization: token abc123` and
 * an all-letter Bearer token are credentials too. A value that already
 * starts with the marker (a header taken inside a quoted string) does not
 * match, so the scan resumes after it and a later header on the same line is
 * still read. The test sits right after the colon and reads past the blanks
 * itself, so the separator giving a blank back cannot defeat it. Groups:
 * 1 name and separator, 2 value.
 */
const AUTHORIZATION_HEADER = new RegExp(
  String.raw`(["']?\b(?:Authorization|Set-Cookie|Cookie)\b["']?[ \t]*[:=](?![ \t]*["']?\[REDACTED\])[ \t]*)(${QUOTED}|[^\r\n]+)`,
  "gi",
);

// ── Pass 3: Bearer and Basic tokens (port of the MCP server's redactor) ─────

/**
 * The MCP server's pattern, with the two optional quotes captured: a closing
 * quote with no partner after the scheme belongs to the string the credential
 * was in (`"password":"Bearer x"`) and is put back, which upstream does not
 * do. Groups: 1 scheme, 2 opening quote, 3 token, 4 closing quote.
 */
const SCHEME_CREDENTIAL = /\b(Bearer|Basic)\s+(["']?)([A-Za-z0-9._~+/-]+=*)(["']?)/gi;

const UTF8 = new TextDecoder("utf-8", { fatal: true });

// Decode as UTF-8 so a password with non-English characters still counts.
function isUserPassword(value: string): boolean {
  try {
    const text = UTF8.decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)));
    // Requiring a username keeps words like "Okta" out, which decode to a colon and a few characters.
    return /^[^\p{Cc}:]+:[^\p{Cc}]*$/u.test(text);
  } catch {
    return false;
  }
}

// Prose uses "basic" and "bearer" as ordinary words, so only a token-shaped value after them counts.
function isCredential(scheme: string, value: string): boolean {
  const basic = scheme.toLowerCase() === "basic";
  if (basic && isUserPassword(value)) return true;
  if (value.length < 8 || /^[A-Za-z][a-z]*$/.test(value)) return false;
  return !basic || (/^[A-Za-z0-9+/]+=*$/.test(value) && /[\d+/=]/.test(value));
}

// ── Pass 4: name and value ──────────────────────────────────────────────────

/** The `<WORD> KEY` names, with `joiner` (or nothing, as in camelCase) between the halves. */
const keyWord = (joiner: string): string =>
  String.raw`(?:API|PRIVATE|ENCRYPTION|ACCESS|SIGNING|SESSION)${joiner}?KEY`;

/**
 * A word that makes a name secret-looking wherever it appears in the name
 * (`CLERK_SECRET_KEY`, `clerkApiKey`, `DATABASE_PASSWORD`, `--db-password`).
 * `AUTH` alone must be a whole segment so `oauth_client_id` and `author`
 * stay. `joiner` is what may sit between the two halves of `API KEY` and the
 * like: `_` or `-` in a bare name or a flag, a space too inside a quoted name.
 */
const secretWord = (joiner: string): string =>
  String.raw`(?:SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|${keyWord(joiner)}|AUTHORIZATION|(?<![A-Za-z0-9])(?:AUTH|PASS|PWD)(?![A-Za-z0-9]))`;

/**
 * A run of name characters, taken atomically: the lookahead captures the
 * whole run into `group`, and the caller's backreference consumes it, so the
 * engine never retries shorter prefixes of the run. The run must contain a
 * secret-looking word, tested once by the first lookahead.
 */
const secretName = (chars: string, joiner: string, group: string): string =>
  String.raw`(?=${chars}*?${secretWord(joiner)})(?=(?<${group}>${chars}+))`;

/** The MCP server's names that may be written with a space, as fixed phrases. */
const SPACED_SECRET_NAME = String.raw`(?:api key|access token|refresh token|auth token|client secret|secret (?:access )?key)(?![A-Za-z0-9_.-])`;

/**
 * A Bearer or Basic scheme followed by its token, as the value of a
 * secret-looking name (`token: Bearer xyz`). Pass 3 skips a token that looks
 * like an ordinary word; after a secret-looking name it is a credential
 * whatever it looks like.
 */
const SCHEME_VALUE = String.raw`(?:Bearer|Basic)[ \t]+(?:[^\s"\\]|\\(?!"))+`;

/** A shell word: non-blank characters, through any quoted part they contain (`MY_TOKEN="alpha beta"`). */
const SHELL_WORD = String.raw`(?:${ANY_QUOTED}|[^\s"'])+`;
/** A JSON field's value: quoted, or a number or boolean that stops at `,`, `;` or `}`. */
const JSON_VALUE = String.raw`(?:${ANY_QUOTED}|[^\s,;}]+)`;
/**
 * A bare value: quoted, or unquoted up to the first whitespace or double
 * quote (an escaped one included). Stopping at a double quote keeps the rest
 * of a JSON string or log line that the assignment sits in.
 */
const BARE_VALUE = String.raw`(?:${SCHEME_VALUE}|${ANY_QUOTED}|(?:[^\s"\\]|\\(?!"))+)`;

/**
 * Separator of an assignment or a field: `:` or `=`, or a two- or three-
 * character operator from another language (Go's `:=`, Ruby and PHP's `=>`,
 * and the comparisons `==` and `===`), longest first. It never crosses a line
 * break.
 */
const ASSIGN = String.raw`[ \t]*(?:===|==|=>|:=|[:=])[ \t]*`;

/**
 * The three name shapes, in one left-to-right pass so none can take part of
 * another's value. The leading lookbehind lets a match start only at the
 * beginning of a run of name characters.
 *
 * - `--flag value` and `--flag=value`: the value is the next shell word, and
 *   cannot itself be a flag (`--token --other` is left alone). A flag name
 *   may contain `_` as well as `-` (`--api_key`).
 * - `"name": value`, a JSON field whose quotes may be escaped.
 * - A bare name, `NAME=value` or `name: value`, with or without `export`
 *   before it.
 */
const NAME_VALUE = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])(?:` +
    String.raw`(?=--)${secretName("[A-Za-z0-9_-]", "[_-]", "flag")}\k<flag>(?<flagSep>=|[ \t]+)(?!-)(?<flagValue>${SCHEME_VALUE}|${SHELL_WORD})` +
    "|" +
    String.raw`(?<quote>\\?["'])${secretName("[A-Za-z0-9_. -]", "[_ -]", "jsonName")}\k<jsonName>\k<quote>(?<jsonSep>${ASSIGN})(?<jsonValue>${JSON_VALUE})` +
    "|" +
    String.raw`(?:(?<spaced>${SPACED_SECRET_NAME})|${secretName("[A-Za-z0-9_.-]", "[_-]", "bare")}\k<bare>)(?<bareSep>${ASSIGN})(?<bareValue>${BARE_VALUE})` +
    ")",
  "gi",
);

/**
 * A camelCase segment `Pass`, `Pwd` or `Auth` (or all capitals) after a
 * lowercase letter or digit, ending where the next segment starts:
 * `dbPass`, `userPwd`, `clientAuth`, `dbPASS`. `NAME_VALUE` runs
 * case-insensitively, so it cannot see a camelCase boundary; this pattern is
 * case-sensitive instead, and lowercase words that contain the letters
 * (`bypass`, `compass`, `isPassed`, `clientAuthor`) do not match. No
 * inline case modifiers: the Bun that builds release binaries may not
 * support them, and an unsupported one would fail at load.
 */
const CAMEL_SECRET_WORD = String.raw`(?<=[a-z0-9])(?:(?:Pass|Pwd|Auth)(?![a-z])|(?:PASS|PWD|AUTH)(?![A-Za-z]))`;
const camelSecretName = (chars: string, group: string): string =>
  String.raw`(?=${chars}*?${CAMEL_SECRET_WORD})(?=(?<${group}>${chars}+))`;

/**
 * Pass 4, second half: a camelCase secret name and its value, as a flag, a
 * JSON field or a bare name, with the same separators and value rules as
 * {@link NAME_VALUE}. A value already replaced by the first half is left alone.
 */
/**
 * A line that runs curl, from the word `curl` to the end of the line. The
 * matches never overlap, so {@link CURL_USER} reads each character once.
 */
const CURL_LINE = /\bcurl\b[^\r\n]*/g;

/**
 * curl's `-u user:password` (also `--user`, `--user=` and `-uuser:password`):
 * the value is one shell word. The callback keeps a value with no colon,
 * since curl then asks for the password. `--user-agent` is not matched: the
 * value cannot start with `-`.
 */
const CURL_USER = new RegExp(
  String.raw`(?<![^\s])(?<flag>-u|--user)(?<sep>=|[ \t]+|)(?!-)(?<value>${SHELL_WORD})`,
  "g",
);

const CAMEL_NAME_VALUE = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])(?:` +
    String.raw`(?=--)${camelSecretName("[A-Za-z0-9_-]", "flag")}\k<flag>(?<flagSep>=|[ \t]+)(?!-)(?<flagValue>${SCHEME_VALUE}|${SHELL_WORD})` +
    "|" +
    String.raw`(?<quote>\\?["'])${camelSecretName("[A-Za-z0-9_.-]", "jsonName")}\k<jsonName>\k<quote>(?<jsonSep>${ASSIGN})(?<jsonValue>${JSON_VALUE})` +
    "|" +
    String.raw`${camelSecretName("[A-Za-z0-9_.-]", "bare")}\k<bare>(?<bareSep>${ASSIGN})(?<bareValue>${BARE_VALUE})` +
    ")",
  "g",
);

type NameValueGroups = {
  flag?: string;
  flagSep?: string;
  flagValue?: string;
  quote?: string;
  jsonName?: string;
  jsonSep?: string;
  jsonValue?: string;
  spaced?: string;
  bare?: string;
  bareSep?: string;
  bareValue?: string;
};

// ── Pass 5: known key prefixes ──────────────────────────────────────────────

/** Port of the MCP server's prefix patterns, in its order. */
const UPSTREAM_PREFIX_PATTERNS = [
  /\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9_-]+\b/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/gi,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gi,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}\b/gi,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bGOCSPX-[A-Za-z0-9_-]{8,}/g,
  /\bwhsec_[A-Za-z0-9+/=]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

/**
 * The CLI's additions: Platform API keys (only the prefix is documented, so
 * the body is permissive); Clerk M2M tokens (`mt_`) and OAuth access tokens
 * (`oat_`), whose prefixes `@clerk/backend` defines without a body format, so
 * the body is 16 or more letters and digits, long enough to leave identifiers
 * such as `mt_rand` alone; Clerk dev-browser tokens (`dvb_` and a 27-character
 * id, or 64 hex digits), the `__clerk_db_jwt` value of a development
 * instance; and `sk-` keys as OpenAI and Anthropic issue them.
 */
const CLI_PREFIX_PATTERNS = [
  /\bak_[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:mt|oat)_[A-Za-z0-9]{16,}\b/g,
  /\bdvb_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
];

// ── Pass 6: credentials in URLs ─────────────────────────────────────────────

/**
 * `scheme://user:password@host`: `user:password` goes, scheme and host stay.
 * The username may be empty (`redis://:password@host`). The password runs to
 * the last `@` within the bound, so one containing `/` or `@` (a raw
 * connection string) is still taken whole. The lookbehind stops the scheme
 * from starting mid-word.
 */
const URL_CREDENTIAL = new RegExp(
  String.raw`(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s@/:]*:\S{0,${URL_PASSWORD_MAX_LENGTH}}@`,
  "gi",
);

// ── Pass 7: home directories ────────────────────────────────────────────────

/**
 * Where a home directory may start: at a word edge that is not already inside
 * a longer path or URL path (`https://x.com/Users/a` is not a home), or right
 * after `file://`, which is how Bun and Node print stack-trace paths.
 */
const HOME_DIR_START = String.raw`(?:(?<![\w/\\])|(?<=file:\/\/))`;

/**
 * `/Users/<name>`, `/home/<name>` and `C:\Users\<name>` (also with the doubled
 * backslashes of a JSON string, lowercase on Windows, forward slashes
 * `C:/Users/<name>`, and the Git Bash and WSL spellings `/c/Users/<name>` and
 * `/mnt/c/Users/<name>`). The rest of the path survives: `/Users/a/app` →
 * `~/app`. The POSIX forms are case-sensitive on purpose: `/users/user_123`
 * is a Backend API path, not a home. The user name is letters (with their
 * combining marks, as in a decomposed accent or a Devanagari vowel sign),
 * digits, `_` and `-`, with dots between them, so punctuation after it stays
 * (`see /Users/bob.` → `see ~.`, `(/Users/bob)` → `(~)`).
 */
const GENERIC_HOME_DIR = new RegExp(
  String.raw`${HOME_DIR_START}(?:\/Users\/|\/home\/|(?:\/mnt)?\/[A-Za-z]\/Users\/|[A-Za-z]:(?:\\{1,2}[Uu]sers\\{1,2}|\/[Uu]sers\/))[\p{L}\p{M}\p{N}_-]+(?:\.[\p{L}\p{M}\p{N}_-]+)*`,
  "gu",
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The current user's home directory as a pattern, or null when there is nothing usable to match. */
function literalHomeDirPattern(home: string): RegExp | null {
  const trimmed = home.replace(/[\\/]+$/, "");
  // A root or one-segment home (`/`, `C:`) would turn every path into `~`.
  if (trimmed.length < 2 || !/[\\/].+/.test(trimmed)) return null;
  // A Windows home may appear with doubled backslashes inside a JSON string.
  const body = escapeRegExp(trimmed).replaceAll("\\\\", "\\\\{1,2}");
  // Not followed by another user-name character (the generic pattern's: letters
  // with their combining marks, digits, `_`, `-`, and `.` when a name character
  // follows it), so `/Users/shane-old` is not `~-old`; any other character,
  // punctuation and brackets included, ends the home (`/root.`, `(/srv/alice)`).
  return new RegExp(
    `${HOME_DIR_START}${body}(?![\\p{L}\\p{M}\\p{N}_-]|\\.[\\p{L}\\p{M}\\p{N}_-])`,
    "gu",
  );
}

// ── Pass 8: email addresses ─────────────────────────────────────────────────

/**
 * The lookbehind keeps the local part whole (no match starting mid-word). An
 * address in brackets (`[a@b.io]`, a Markdown link) is still an address. The
 * `[REDACTED]@host` the URL pass leaves behind is not: the character before
 * its `@` is `]`, which a local part cannot end with.
 */
const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * Each side independently: a value that an earlier pass already replaced can
 * arrive with a quote on one side only.
 */
function stripQuotes(value: string): string {
  return value.replace(/^\\?["']/, "").replace(/\\?["']$/, "");
}

// ── Entry points ────────────────────────────────────────────────────────────

/**
 * Scrub secrets, home-directory paths and email addresses from `text`, in
 * the eight passes the module comment lists. `homedir` is injectable for
 * tests; production callers omit it.
 *
 * Counting: passes 2 and 4 leave a value alone, uncounted, when it already
 * starts with the marker (an earlier pass took the credential inside it);
 * every other pass counts each match.
 */
export function redactText(text: string, options: { homedir?: string } = {}): Redaction {
  let redactions = 0;
  const count = (): string => {
    redactions += 1;
    return REDACTED;
  };

  let out = text.replace(PRIVATE_KEY_BLOCK, count);

  out = out.replace(AUTHORIZATION_IN_STRING, (match: string, ...rest: unknown[]) => {
    const g = rest.at(-1) as HeaderInStringGroups;
    const [open, name, value] =
      g.escOpen !== undefined ? [g.escOpen, g.escName!, g.escValue!] : [g.open!, g.name!, g.value!];
    if (value.trim() === "" || value.startsWith(REDACTED)) return match;
    redactions += 1;
    return `${open}${name}${REDACTED}`;
  });
  out = out.replace(AUTHORIZATION_HEADER, (match, name: string, value: string) => {
    if (stripQuotes(value).startsWith(REDACTED)) return match;
    redactions += 1;
    return `${name}${REDACTED}`;
  });

  out = out.replace(
    SCHEME_CREDENTIAL,
    (match, scheme: string, open: string, value: string, close: string) => {
      const token = value.replace(/\.+$/, "");
      if (!isCredential(scheme, token)) return match;
      redactions += 1;
      // A quote pair around the token goes with it; a lone closing quote
      // belongs to the string around the credential and stays.
      const keptClose = open !== "" && open === close ? "" : close;
      return REDACTED + value.slice(token.length) + keptClose;
    },
  );

  const nameValue = (match: string, ...rest: unknown[]): string => {
    const g = rest.at(-1) as NameValueGroups;
    const [name, separator, value] =
      g.flag !== undefined
        ? [g.flag, g.flagSep!, g.flagValue!]
        : g.jsonName !== undefined
          ? [`${g.quote}${g.jsonName}${g.quote}`, g.jsonSep!, g.jsonValue!]
          : [g.spaced ?? g.bare!, g.bareSep!, g.bareValue!];
    if (stripQuotes(value).startsWith(REDACTED)) return match;
    // The shell's working directory is a path, not a password.
    if (/^(?:OLD)?PWD$/i.test(name) && /^[~/]/.test(value)) return match;
    redactions += 1;
    return `${name}${separator}${REDACTED}`;
  };
  out = out.replace(NAME_VALUE, nameValue);
  out = out.replace(CAMEL_NAME_VALUE, nameValue);
  out = out.replace(CURL_LINE, (line) =>
    line.replace(CURL_USER, (match, flag: string, sep: string, value: string) => {
      if (!value.includes(":") || stripQuotes(value).startsWith(REDACTED)) return match;
      redactions += 1;
      return `${flag}${sep}${REDACTED}`;
    }),
  );

  for (const pattern of UPSTREAM_PREFIX_PATTERNS) out = out.replace(pattern, count);
  for (const pattern of CLI_PREFIX_PATTERNS) out = out.replace(pattern, count);

  out = out.replace(URL_CREDENTIAL, (_match, scheme: string) => {
    redactions += 1;
    return `${scheme}${REDACTED}@`;
  });

  const tilde = (): string => {
    redactions += 1;
    return "~";
  };
  const literalHome = literalHomeDirPattern(options.homedir ?? homedir());
  if (literalHome) out = out.replace(literalHome, tilde);
  out = out.replace(GENERIC_HOME_DIR, tilde);

  out = out.replace(EMAIL, () => {
    redactions += 1;
    return EMAIL_MARKER;
  });

  return { text: out, redactions };
}

/**
 * Prepare one free-text field for sending: scrub the whole field, then cut
 * it to `cap`. Scrubbing first means a secret that starts inside the cap and
 * runs past it is matched whole, however long it is, and `redactions`
 * describes the field as pasted, cut or not.
 *
 * The cut never leaves part of a marker: a `[REDACTED]` or `[EMAIL]` that
 * straddles the cap is dropped whole rather than sent as `[REDA`, which a
 * reader could not tell from a secret cut short.
 */
export function redactAndCap(
  text: string,
  cap: number,
  options: { homedir?: string } = {},
): Redaction {
  const scrubbed = redactText(text, options);
  return { text: cutKeepingMarkersWhole(scrubbed.text, cap), redactions: scrubbed.redactions };
}

const MARKERS = [REDACTED, EMAIL_MARKER];

function cutKeepingMarkersWhole(text: string, cap: number): string {
  if (text.length <= cap) return text;
  let end = cap;
  for (const marker of MARKERS) {
    const start = text.lastIndexOf(marker, cap - 1);
    if (start !== -1 && start + marker.length > cap) end = Math.min(end, start);
  }
  // The cap counts UTF-16 code units; never leave the first half of a
  // surrogate pair (half an emoji) as the last unit.
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}
