/**
 * Client-side scrubbing for the free text `clerk feedback` sends.
 *
 * Every free-text field of a feedback report passes through
 * {@link redactAndCap} before it leaves the machine: the whole field is
 * scrubbed first, then cut to its cap. Nothing is cut before scrubbing, so a
 * secret can never be split into a fragment that no pattern recognises. The
 * command bounds what reaches this module (a field over its ceiling is a
 * usage error), and every pass below is linear in the size of its input, so
 * the cost of a field is bounded by construction, not by a timing test.
 *
 * ## The linearity rule
 *
 * Every pattern obeys one rule: a match attempt that fails costs work bounded
 * by a constant, or by text that the next successful match consumes, and no
 * position inside a run is tried as a start. Concretely:
 *
 * - A start position is pinned by a literal (`-----BEGIN`, `Authorization`,
 *   a key prefix) or by a lookbehind that refuses to start inside a run of
 *   name characters, so the engine never retries from every character of a
 *   long run.
 * - A run of name characters is taken atomically: a lookahead captures the
 *   whole run and a backreference consumes it, so a later failure cannot make
 *   the engine try every shorter prefix. The run is tested once, lazily, for
 *   a secret-looking word.
 * - A quoted value ends on its line. A quote with no partner on its line
 *   takes the rest of the line, so the engine never scans ahead for a
 *   partner, and a truncated value is taken whole.
 * - A URL password is bounded ({@link URL_PASSWORD_MAX_LENGTH}), because the
 *   password may contain `/`, `:` and `@` and so has no delimiter to stop at.
 * - A private key block with no END line runs to the end of the text in the
 *   same scan, rather than being retried from every BEGIN, and the words of a
 *   BEGIN or END header are bounded.
 * - A name with spaces is at most three runs, and its containment test reads
 *   no further than those runs.
 * - The YAML pass is a forward walk over lines, not a pattern: each line is
 *   examined once as a possible parent and at most once as part of a block.
 * - No separator crosses a line break.
 *
 * The timing tests in `redact.test.ts` are the backstop for this rule: each
 * adversarial shape is run at two sizes and must not take more than about
 * twice as long when the input doubles.
 *
 * ## The passes, in order
 *
 * 1. Private key blocks (`-----BEGIN … PRIVATE KEY … -----` to the matching
 *    END or the end of the text, PGP included). First because they span
 *    lines and every later pass stops at a line or a space.
 * 2. YAML values on the lines below their key: a block scalar
 *    (`password: |` then indented lines) becomes one marker, and the
 *    children of a parent with a secret-looking name (`secrets:` then
 *    `  db_password: x`) keep their names and lose their values. After pass
 *    1 so a key block inside a block scalar is one secret, not two; before
 *    every single-line pass, which would take only the indicator (`|`).
 * 3. `Authorization` headers: the whole value to the end of the line, or the
 *    quoted value when the header is a JSON field. Before the name pass,
 *    which would take only the first word of the value (`Bearer`).
 * 4. `Bearer` and `Basic` credentials in prose, with the upstream guards that
 *    keep ordinary words out. Before the name pass so `token: Bearer xyz`
 *    loses `xyz` rather than the word `Bearer`. Quotes that belong to the
 *    string around the credential stay, so the next JSON field still parses.
 * 5. Name and value, in one pass for the three shapes a pasted line takes:
 *    `--flag value` (or `--flag=value`), `NAME=value` and `"name": value`,
 *    where the name contains a secret-looking word (a bare name may be two or
 *    three words ending in a secret noun: `api key: x`). Only the value is
 *    replaced, so a reader still learns which variable or flag was pasted.
 *    A flag value is a shell word (through any quoted part, spaces included).
 *    An unquoted bare value is the rest of its line when the name starts the
 *    line (a dotenv or YAML line: `KEY=a b c` means `a b c`) or the
 *    separator is a colon (prose and headers); after an `=` in the middle of
 *    a line (logfmt, a query string) it is a shell word. Nothing tells a
 *    dotenv line from a shell command line, so a line-start assignment always
 *    takes the rest of the line, which over-redacts a command that follows an
 *    environment assignment. A JSON field's unquoted value stops at `,`, `;`
 *    or `}` so the rest of a one-line log survives.
 * 6. Known key prefixes (`sk_test_`, `ghp_`, `AKIA`, …, plus the CLI's
 *    `ak_` Platform API keys and `sk-` keys). After the name pass so a value
 *    already replaced is not counted twice.
 * 7. Credentials in URLs (`scheme://user:password@host`): the credential
 *    goes, scheme and host stay.
 * 8. Home directories: the current user's literal home first (the text may
 *    name another user's home, or the CLI may run under `sudo`), then the
 *    generic `/Users/<name>`, `/home/<name>` and `C:\Users\<name>` shapes,
 *    also after `file://` as stack traces print them.
 * 9. Email addresses, last, so an address inside a secret already replaced
 *    is not counted twice.
 *
 * ## Relation to the MCP server's redactor
 *
 * Passes 4 and 6 are a port of the redactor in Clerk's MCP server, pattern
 * for pattern and in its order, so the two stay easy to compare (pass 4
 * differs in one way: it puts back a closing quote that belongs to the string
 * around the credential); secrets
 * become the same `[REDACTED]` marker so reports from both read the same. Two
 * of the upstream patterns are deliberately not carried:
 *
 * - Upstream's `Authorization: Bearer|Basic <token>` pattern is replaced by
 *   pass 3, which takes any scheme and any value.
 * - Upstream's `name: value` pattern, which replaces the name together with
 *   the value for a fixed list of names (`api_key`, `token`, `password`, …),
 *   is replaced by pass 5. Pass 5 matches every name on that list, because
 *   each contains one of its words, and it keeps the name. The two also stop
 *   an unquoted value differently: upstream stops at a comma, which would
 *   send the rest of a `.env` password that contains one.
 *
 * ## Known limits, each pinned by a test so a later change is deliberate
 *
 * - A quoted value that spans lines keeps its later lines (pass 5 ends a
 *   value on its line). Private key blocks are taken whole by pass 1, and
 *   YAML block scalars by pass 2.
 * - Two truncated quoted values on one line: the second's opening quote
 *   closes the first, and the second value survives.
 * - A URL password longer than {@link URL_PASSWORD_MAX_LENGTH} characters is
 *   outside pass 7; the email pass still removes it, but the username before
 *   it survives.
 * - A home directory whose user name contains a space keeps the second word.
 * - Over-matches in the safe direction: any name containing `TOKEN`
 *   (`max_tokens=4096`), a user segment in a URL with no password
 *   (`https://git@github.com/x`), a URL with a port and an email in its query
 *   string (which loses its host), prose naming the `Authorization`
 *   header (which loses the rest of its line), every child of a YAML
 *   parent with a secret-looking name (`auth:` then `  enabled: true`), and
 *   a command after an environment assignment at the start of a line
 *   (`DB_PASSWORD=x npm start` loses `npm start`).
 * - An unquoted value after an `=` in the middle of a line keeps only its
 *   first word redacted (`… with password=correct horse` keeps `horse`):
 *   logfmt and query strings need the shell-word rule there.
 * - `redactions` counts replacements, one per secret for the common shapes;
 *   it is a "read this report carefully" signal, not a tally.
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

// ── Pass 1: private key blocks ──────────────────────────────────────────────

/**
 * `-----BEGIN <kind> PRIVATE KEY <kind>-----` to the matching END line, or to
 * the end of the text when no END line arrived (a truncated paste). The
 * header allows words on both sides of `PRIVATE KEY` so OpenSSH, RSA,
 * encrypted and PGP (`PGP PRIVATE KEY BLOCK`) headers all match. Those words
 * are bounded (real headers carry a dozen characters or so), which is what
 * keeps a malformed header linear: unbounded, a header that repeats
 * `PRIVATE KEY` with no closing dashes was rescanned to the end of its line
 * from every repetition.
 */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [^\r\n-]{0,40}PRIVATE KEY[^\r\n-]{0,40}-----[\s\S]*?(?:-----END [^\r\n-]{0,40}PRIVATE KEY[^\r\n-]{0,40}-----|$)/gi;

// ── Quoted values, shared by passes 3 and 5 ─────────────────────────────────

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

/** A shell word: non-blank characters, through any quoted part they contain (`MY_TOKEN="alpha beta"`). */
const SHELL_WORD = String.raw`(?:${ANY_QUOTED}|[^\s"'])+`;
/** A JSON field's value: quoted, or a number or boolean that stops at `,`, `;` or `}`. */
const JSON_VALUE = String.raw`(?:${ANY_QUOTED}|[^\s,;}]+)`;

// ── Pass 3: Authorization headers ───────────────────────────────────────────

/**
 * `Authorization: <anything to the end of the line>`, or a quoted value when
 * the header is a JSON field. Any scheme: `Authorization: token abc123` and
 * an all-letter Bearer token are credentials too. Groups: 1 name and
 * separator, 2 value.
 */
const AUTHORIZATION_HEADER = new RegExp(
  String.raw`(["']?\bAuthorization\b["']?[ \t]*[:=][ \t]*)(${QUOTED}|[^\r\n]+)`,
  "gi",
);

// ── Pass 4: Bearer and Basic credentials (port of the MCP server's redactor) ─

/**
 * The MCP server's pattern, with the two optional quotes captured: a closing
 * quote with no partner after the scheme belongs to the string the credential
 * was in (`"password":"Bearer x"`) and is put back, which upstream does not
 * do. Dropping it made the next field's quotes pair up wrongly and let its value
 * through. Groups: 1 scheme, 2 opening quote, 3 token, 4 closing quote.
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

// ── Pass 5: name and value ──────────────────────────────────────────────────

/**
 * A word that makes a name secret-looking wherever it appears in the name
 * (`CLERK_SECRET_KEY`, `clerkApiKey`, `DATABASE_PASSWORD`, `--db-password`).
 * `AUTH` alone must be a whole segment so `oauth_client_id` and `author`
 * stay. `joiner` is what may sit between the two halves of `API KEY` and the
 * like: `_` or `-` in a bare name or a flag, a space too inside a quoted name.
 */
const secretWord = (joiner: string): string =>
  String.raw`(?:SECRET|TOKEN|PASSWORD|PASSWD|API${joiner}?KEY|PRIVATE${joiner}?KEY|ENCRYPTION${joiner}?KEY|AUTHORIZATION|(?<![A-Za-z0-9])AUTH(?![A-Za-z0-9]))`;

/**
 * A run of name characters, taken atomically: the lookahead captures the
 * whole run into the next group, and the caller's backreference consumes it,
 * so the engine never retries shorter prefixes of the run (see the linearity
 * rule). The run must contain a secret-looking word, tested once by the
 * first lookahead. `chars` is the run's character class.
 */
const secretName = (chars: string, joiner: string): string =>
  String.raw`(?=${chars}*?${secretWord(joiner)})(?=(${chars}+))`;

/** The last word of a name with spaces must be one of these for the words before it to join the name. */
const SECRET_NOUN = "(?:key|token|secret|password|passwd|auth|authorization)";

/**
 * A bare name: one run of name characters, or two or three runs joined by
 * single spaces whose last run is a {@link SECRET_NOUN} (`api key`,
 * `secret access key`, `the password`). The noun rule keeps a value elsewhere
 * on the line from being taken: in `invalid token for user_id=x` the name
 * would end in `user_id`, so it is not a name at all. Taken atomically like
 * {@link secretName}, and the containment test reads at most the same three
 * runs, so each run is read from at most three starting positions.
 */
const BARE_NAME_CHARS = "[A-Za-z0-9_.-]";
const BARE_SECRET_NAME =
  String.raw`(?=(?:${BARE_NAME_CHARS}+ ){0,2}?${BARE_NAME_CHARS}*?${secretWord("[_ -]")})` +
  String.raw`(?=((?:${BARE_NAME_CHARS}+ ){1,2}${SECRET_NOUN}(?!${BARE_NAME_CHARS})|${BARE_NAME_CHARS}+))`;

/**
 * The start of a line, after indentation, a YAML list dash or `export`. It
 * reads back over the blanks before the current position, so it is placed
 * after the secret-name test and before the name is consumed: tested first,
 * it ran at every blank of a long
 * run of blanks and read back over the whole run each time, which was
 * quadratic. After the test it runs only where a secret name starts, and the
 * blanks before one name are read for that name alone.
 */
const LINE_START = String.raw`(?<=(?:^|[\r\n])[ \t]*(?:- )?(?:export[ \t]+)?)`;

/**
 * An unquoted value that is the rest of its line, starting at a non-blank (so
 * trailing blanks after a separator are never a value); a quoted one still
 * ends at its quote.
 */
const LINE_VALUE = String.raw`(?:(?=\\?["'])${SHELL_WORD}|[^\s][^\r\n]*)`;

/** Separator of an assignment or a field: never crosses a line break, so a YAML parent cannot take its child's name as its value. */
const ASSIGN = String.raw`[ \t]*[:=][ \t]*`;

/**
 * The three name shapes, each with its own separator and stop rule, in one
 * left-to-right pass so none can take part of another's value:
 *
 * - `--flag value` and `--flag=value`: the value is the next shell word, and
 *   cannot itself be a flag (`--token --other` is left alone).
 *   Groups 1 flag, 2 separator, 3 value.
 * - `"name": value` (a JSON field; the quotes may be escaped): the value
 *   stops where a JSON value does. Groups 4 quote, 5 name, 6 separator,
 *   7 value.
 * - A bare name (`NAME=value`, `name: value`, also `api key: value`), in
 *   three forms tried in this order. At the start of a line (after
 *   indentation, a list dash or `export`), any separator: a dotenv or YAML
 *   line, whose unquoted value is the rest of the line (`KEY=a b c` means
 *   `a b c`). Anywhere, a colon: prose and headers (`the password: a b c`),
 *   also to the end of the line. In the middle of a line, `=`: logfmt and
 *   query strings, where the value is a shell word. A quoted value ends at
 *   its quote in every form. The name is tested once (group 8); the three
 *   forms are separator and value pairs, groups 9 and 10, 11 and 12, 13 and
 *   14.
 * - A flag name may contain `_` as well as `-` (`--api_key`).
 *
 * The leading lookbehind lets a match start only at the beginning of a run
 * of name characters. No separator crosses a line break.
 */
const NAME_VALUE = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])(?:` +
    String.raw`(?=--)${secretName("[A-Za-z0-9_-]", "[_-]")}\1(=|[ \t]+)(?!-)(${SHELL_WORD})` +
    "|" +
    String.raw`(\\?["'])${secretName("[A-Za-z0-9_. -]", "[_ -]")}\5\4(${ASSIGN})(${JSON_VALUE})` +
    "|" +
    // The name test runs once; only the separator and value branch.
    String.raw`${BARE_SECRET_NAME}(?:` +
    String.raw`${LINE_START}\8(${ASSIGN})(${LINE_VALUE})` +
    "|" +
    String.raw`\8([ \t]*:[ \t]*)(${LINE_VALUE})` +
    "|" +
    String.raw`\8([ \t]*=[ \t]*)(${SHELL_WORD})` +
    ")" +
    ")",
  "gi",
);

// ── Pass 2: YAML values on the lines below their key ────────────────────────
// Defined here, after pass 5, because it shares that pass's name rules.

/** A block-scalar indicator (`|`, `>-`, `|2+`), optionally followed by a comment. */
const BLOCK_SCALAR_INDICATOR = /^[|>][0-9+-]{0,3}(?:[ \t]+#.*)?$/;
/** A YAML key as a parent line carries it: one to three runs of name characters. */
const YAML_PARENT_KEY = /^[A-Za-z0-9_.-]+(?: [A-Za-z0-9_.-]+){0,2}$/;
const YAML_SECRET_WORD = new RegExp(secretWord("[_ -]"), "i");
const YAML_SECRET_NOUN_LAST = new RegExp(String.raw`(?:^| )${SECRET_NOUN}$`, "i");
/** A child line's key, before its colon. */
const YAML_CHILD_KEY = /^(?:"[^"]*"|'[^']*'|[A-Za-z0-9_.-]+(?: [A-Za-z0-9_.-]+)*)$/;
/** Longest key a parent line may carry; a longer "key" is prose, and the bound keeps each line's check constant. */
const YAML_KEY_MAX_LENGTH = 128;

type YamlParent = { indent: number; head: string; blockScalar: boolean };

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  return i;
}

function withoutCr(line: string): [body: string, cr: string] {
  return line.endsWith("\r") ? [line.slice(0, -1), "\r"] : [line, ""];
}

/**
 * `key:` with nothing after it, or `key: |` (a block scalar), where the key
 * contains a secret-looking word and, if it has spaces, ends in a secret noun
 * (so a prose heading such as `Token refresh fails:` is not a parent). The
 * colon is the first one on the line, as in a YAML key.
 */
function yamlParent(line: string): YamlParent | null {
  const [body] = withoutCr(line);
  const colon = body.indexOf(":");
  if (colon <= 0 || colon > YAML_KEY_MAX_LENGTH + 8) return null;
  const rest = body.slice(colon + 1).trim();
  const blockScalar = BLOCK_SCALAR_INDICATOR.test(rest);
  if (rest !== "" && !rest.startsWith("#") && !blockScalar) return null;
  const head = body.slice(0, colon);
  let key = head.trim();
  if (key.startsWith("- ")) key = key.slice(2).trimStart();
  key = key.replace(/^(\\?["'])(.*)\1$/, "$2");
  if (key.length > YAML_KEY_MAX_LENGTH || !YAML_PARENT_KEY.test(key)) return null;
  if (!YAML_SECRET_WORD.test(key)) return null;
  if (key.includes(" ") && !YAML_SECRET_NOUN_LAST.test(key)) return null;
  return { indent: indentOf(body), head: `${head}:`, blockScalar };
}

const isMarker = (value: string): boolean => stripQuotes(value.trim()) === REDACTED;

/**
 * One line below a secret-looking parent: a child `name: value` keeps its
 * name and loses its value; a nested `name:` with nothing after it is left
 * for its own children; anything else keeps its indentation and list marker
 * and loses the rest. Null when the line is already clean.
 */
function redactChildLine(line: string): string | null {
  const [body, cr] = withoutCr(line);
  if (body.trim() === "") return null;
  let start = indentOf(body);
  if (body.startsWith("- ", start)) start += 2;
  const content = body.slice(start);
  const colon = content.indexOf(":");
  const key = colon > 0 ? content.slice(0, colon) : "";
  const after = colon > 0 ? content.slice(colon + 1) : "";
  if (key.length <= YAML_KEY_MAX_LENGTH && YAML_CHILD_KEY.test(key) && /^(?:[ \t]|$)/.test(after)) {
    if (after.trim() === "" || isMarker(after)) return null;
    const space = /^[ \t]*/.exec(after)![0];
    return `${body.slice(0, start)}${key}:${space}${REDACTED}${cr}`;
  }
  if (isMarker(content)) return null;
  return `${body.slice(0, start)}${REDACTED}${cr}`;
}

/**
 * Pass 2. A YAML value can sit on the lines below its key: a block scalar
 * (`password: |` then indented lines) or a nested mapping (`secrets:` then
 * indented children). Under a key with a secret-looking name, every
 * following line indented deeper than the key belongs to its value. A block
 * scalar becomes `key: [REDACTED]` (its lines collapse into the one marker);
 * a nested mapping keeps each child's name and loses each child's value.
 *
 * One forward walk over the lines: each line is examined once as a possible
 * parent and at most once as part of a block, and every check on a line is
 * linear in the line's length.
 */
function redactYamlBlocks(text: string, onRedact: () => void): string {
  // Cheap test for a line that could open a block: a colon followed, after
  // optional spaces or tabs, by a block indicator, a comment or the line end.
  if (!/:[ \t]*(?:[|>#]|\r?\n)/.test(text)) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parent = yamlParent(lines[i]!);
    if (!parent) {
      out.push(lines[i]!);
      continue;
    }
    let end = i + 1;
    while (end < lines.length) {
      const [body] = withoutCr(lines[end]!);
      if (body.trim() !== "" && indentOf(body) <= parent.indent) break;
      end++;
    }
    while (end > i + 1 && withoutCr(lines[end - 1]!)[0].trim() === "") end--;
    if (end === i + 1) {
      out.push(lines[i]!);
      continue;
    }
    const block = lines.slice(i + 1, end);
    if (parent.blockScalar) {
      // A key block inside it was already taken by pass 1: not a second secret.
      if (!block.every((line) => line.trim() === "" || isMarker(line))) onRedact();
      out.push(`${parent.head} ${REDACTED}${withoutCr(lines[i]!)[1]}`);
    } else {
      out.push(lines[i]!);
      for (const line of block) {
        const redacted = redactChildLine(line);
        if (redacted === null) out.push(line);
        else {
          onRedact();
          out.push(redacted);
        }
      }
    }
    i = end - 1;
  }
  return out.join("\n");
}

// ── Pass 6: known key prefixes ──────────────────────────────────────────────

/**
 * Port of the MCP server's prefix patterns, in its order. Not carried from
 * upstream, as the module comment explains: its `Authorization: Bearer|Basic`
 * pattern (pass 2 is the superset) and its `name: value` pattern (pass 4 is
 * the superset and keeps the name).
 */
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

/** The CLI's additions: Platform API keys (only the prefix is documented, so the body is permissive), and `sk-` keys as OpenAI and Anthropic issue them. */
const CLI_PREFIX_PATTERNS = [/\bak_[A-Za-z0-9_-]{8,}\b/g, /\bsk-[A-Za-z0-9_-]{20,}/g];

// ── Pass 7: credentials in URLs ─────────────────────────────────────────────

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

// ── Pass 8: home directories ────────────────────────────────────────────────

/**
 * Where a home directory may start: at a word edge that is not already inside
 * a longer path or URL path (`https://x.com/Users/a` is not a home), or right
 * after `file://`, which is how Bun and Node print stack-trace paths.
 */
const HOME_DIR_START = String.raw`(?:(?<![\w/\\])|(?<=file:\/\/))`;

/**
 * `/Users/<name>`, `/home/<name>` and `C:\Users\<name>` (also with the doubled
 * backslashes of a JSON string, and lowercase on Windows). The rest of the
 * path survives: `/Users/a/app` → `~/app`. The POSIX forms are case-sensitive
 * on purpose: `/users/user_123` is a Backend API path, not a home.
 */
const GENERIC_HOME_DIR = new RegExp(
  String.raw`${HOME_DIR_START}(?:\/Users\/|\/home\/|[A-Za-z]:\\{1,2}[Uu]sers\\{1,2})[^\s/\\:"'${"`"}]+`,
  "g",
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
  // Not followed by another user-name character (the generic pattern's class),
  // so `/Users/shane-old` is not `~-old`.
  return new RegExp(`${HOME_DIR_START}${body}(?![^\\s/\\\\:"'${"`"}])`, "g");
}

// ── Pass 9: email addresses ─────────────────────────────────────────────────

/**
 * The lookbehind keeps the local part whole (no match starting mid-word). An
 * address in brackets (`[a@b.io]`, a Markdown link) is still an address. The
 * `[REDACTED]@host` the URL pass leaves behind is not: the character before
 * its `@` is `]`, which a local part cannot end with.
 */
const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * Each side independently: the Bearer pass consumes a closing quote without
 * putting it back, so an already-redacted value can arrive as `"[REDACTED]`
 * with no partner.
 */
function stripQuotes(value: string): string {
  return value.replace(/^\\?["']/, "").replace(/\\?["']$/, "");
}

// ── Entry points ────────────────────────────────────────────────────────────

/**
 * Scrub secrets, home-directory paths and email addresses from `text`, in
 * the nine passes the module comment lists. `homedir` is injectable for
 * tests; production callers omit it.
 *
 * Counting: passes 3 and 5 count unless the value is already the marker
 * (quotes stripped), which happens when an earlier pass took the credential
 * inside the value. Pass 2 counts each child line it changes, and a block
 * scalar once unless pass 1 already took everything in it. Every other pass
 * counts each match.
 */
export function redactText(text: string, options: { homedir?: string } = {}): Redaction {
  let redactions = 0;
  const count = (): string => {
    redactions += 1;
    return REDACTED;
  };

  let out = text.replace(PRIVATE_KEY_BLOCK, count);

  out = redactYamlBlocks(out, () => {
    redactions += 1;
  });

  out = out.replace(AUTHORIZATION_HEADER, (match, name: string, value: string) => {
    if (stripQuotes(value) === REDACTED) return match;
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

  out = out.replace(
    NAME_VALUE,
    (
      match: string,
      flag: string | undefined,
      flagSeparator: string,
      flagValue: string,
      quote: string | undefined,
      quotedName: string,
      quotedSeparator: string,
      quotedValue: string,
      bareName: string,
      ...bareForms: string[]
    ) => {
      // The three bare forms fill groups 9 and 10, 11 and 12, or 13 and 14.
      const [bareSeparator, bareValue] = [0, 2, 4]
        .map((at) => bareForms.slice(at, at + 2))
        .find(([separator]) => separator !== undefined) ?? ["", ""];
      const value = flag ? flagValue : quote ? quotedValue : bareValue!;
      const stripped = stripQuotes(value);
      if (stripped === REDACTED) return match;
      // A value to the end of the line can start with a marker an earlier pass
      // left (`token: [REDACTED] rest`): the rest still goes, but it is the
      // same secret, so it is not counted again.
      if (!stripped.startsWith(REDACTED)) redactions += 1;
      if (flag) return `${flag}${flagSeparator}${REDACTED}`;
      if (quote) return `${quote}${quotedName}${quote}${quotedSeparator}${REDACTED}`;
      return `${bareName}${bareSeparator}${REDACTED}`;
    },
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
