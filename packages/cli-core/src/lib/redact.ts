/**
 * Client-side scrubbing for the free text `clerk feedback` sends.
 *
 * Every free-text field of a feedback report passes through
 * {@link redactAndCap} before it leaves the machine.
 * Scrubbing runs before the field's length cap is applied, on everything up to
 * the cap plus a margin larger than any secret: a secret cut in half by the
 * cap would no longer match the pattern that catches it whole.
 *
 * The upstream block of patterns is a port of the redactor in Clerk's MCP
 * server, kept pattern for pattern and in the same order so the two stay easy
 * to compare. The two are expected to drift, and a change to one is worth
 * considering for the other. Secrets become the same `[REDACTED]` marker the
 * MCP server uses, so reports from both read the same.
 *
 * The CLI additions cover what the upstream set misses for text a local tool
 * sees: `ak_` Platform API keys, `NAME=value` pairs whose name merely
 * *contains* a secret-looking word (the upstream pattern needs the word to
 * start at a word boundary, so `CLERK_SECRET_KEY=` never matches it), the
 * same names as command-line flags (`--password x`), escaped JSON inside a
 * string,
 * credentials inside URLs, an unterminated private-key block, `Authorization`
 * headers with any scheme, home-directory paths (which name the person), and
 * email addresses.
 *
 * Three places depart from "upstream first, additions after", each for a leak:
 * the named-assignment pass runs before the upstream key-value pass because
 * upstream stops an unquoted value at a comma (`password=alpha,beta` would
 * keep `,beta`); the private-key-block pass runs before the named-assignment
 * pass because that pass would otherwise take only the `-----BEGIN` word of a
 * key pasted after its name and leave the key body unmatchable; and the
 * Authorization-header pass runs before the named-assignment pass because that
 * pass would otherwise take only the scheme word (`Authorization: Bearer
 * abcdefghijkl` would keep the token, which the scheme pass rejects as a plain
 * word). The upstream private-key pattern is also widened by one alternative
 * (`|$`, end of text) so a block with no END line is taken in the same scan
 * rather than by a second pass: a lazy BEGIN…END pattern rescans to the end
 * from every unmatched BEGIN, which was quadratic.
 *
 * Known limits, each pinned by a test so a later change is deliberate:
 * - A URL password longer than {@link URL_PASSWORD_MAX_LENGTH} characters is
 *   outside the URL pass (the bound is what keeps that pass linear on long
 *   whitespace-free text). The email pass still removes it, but the username
 *   before it survives.
 * - A home directory whose user name contains a space keeps the second word
 *   (`/Users/John Smith/x` becomes `~ Smith/x`); no pattern can tell where
 *   such a name ends. The sender's own home is matched whole by the literal
 *   pass regardless.
 * - Over-matches in the safe direction: any name containing `TOKEN`
 *   (`max_tokens=4096`), a user segment in a URL with no password
 *   (`https://git@github.com/x`), and a URL with a port and an email in its
 *   query string, which loses its host.
 * - `redactions` is approximate: it counts replacements made, one per secret
 *   for the common shapes, but upstream passes that overlap can still miscount
 *   in contrived text. It is a "read this report carefully" signal, not a
 *   tally.
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

/**
 * How much past a field's cap {@link redactAndCap} keeps before scrubbing.
 * Larger than any single secret, including a 4096-bit RSA key block.
 */
export const REDACTION_MARGIN = 8 * 1024;

export type Redaction = {
  /** The scrubbed text. */
  text: string;
  /** How many replacements were made, across every kind of pattern. Approximate; see the module comment. */
  redactions: number;
};

// ── Ported from the MCP server (upstream) ───────────────────────────────────

const SCHEME_CREDENTIAL = /\b(Bearer|Basic)\s+["']?([A-Za-z0-9._~+/-]+=*)["']?/gi;

/**
 * Upstream's first pattern, with `|$` added so a block whose END line never
 * arrived is taken to the end of the text in the same scan (see the module
 * comment for why that is one pass, and why it runs before the named pass).
 */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gi;

/** Upstream's remaining patterns, in upstream order. */
const UPSTREAM_PATTERNS = [
  /\bAuthorization\s*[:=]\s*(?:Bearer|Basic)\s+["']?[A-Za-z0-9._~+/-]+=*["']?/gi,
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
  /["']?\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|token|client[_ -]?secret|secret(?:[_ -]?(?:access[_ -]?)?key)?|password|passwd|authorization|auth)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,
];

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

// ── CLI additions ───────────────────────────────────────────────────────────

/**
 * A name that contains a secret-looking word, whatever its prefix or suffix:
 * `CLERK_SECRET_KEY`, `clerkApiKey`, `DATABASE_PASSWORD`, `X_AUTH`. `AUTH`
 * alone must be a whole segment so `oauth_client_id` and `author` stay.
 */
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_ -]?KEY|PRIVATE[_-]?KEY|ENCRYPTION[_-]?KEY|AUTHORIZATION|(?<![A-Za-z0-9])AUTH(?![A-Za-z0-9]))[A-Za-z0-9_.-]*`;
const QUOTED_VALUE = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
/**
 * An opening quote with no closing quote before the end of its line: a
 * truncated log, or a value the pre-cut in {@link redactAndCap} split. It runs
 * to the end of the line, because falling through to the unquoted stop rule
 * would send everything after the first comma or space of the secret. An
 * escaped quote inside it (`\"`) is part of the value, not its end.
 */
const OPEN_QUOTED_VALUE = String.raw`"(?:\\.|[^"\\\r\n])*\\?(?![^\r\n])|'(?:\\.|[^'\\\r\n])*\\?(?![^\r\n])`;
/**
 * JSON pasted inside a string arrives with its quotes escaped:
 * `{\"password\":\"x\"}`. The string ends at the next `\"`, and a bare `"`
 * cannot occur inside it. Closed and unterminated forms.
 */
const ESCAPED_QUOTED_VALUE = String.raw`\\"(?:[^"\\]|\\[^"])*\\"|\\'(?:[^'\\]|\\[^'])*\\'`;
const ESCAPED_OPEN_QUOTED_VALUE = String.raw`\\"(?:[^"\\\r\n]|\\[^"\r\n])*(?![^\r\n])|\\'(?:[^'\\\r\n]|\\[^'\r\n])*(?![^\r\n])`;
/** Every quoted-value shape, most specific first, then the unquoted stop rule a caller appends. */
const ANY_QUOTED_VALUE = `${ESCAPED_QUOTED_VALUE}|${ESCAPED_OPEN_QUOTED_VALUE}|${QUOTED_VALUE}|${OPEN_QUOTED_VALUE}`;

/**
 * `NAME=value` and `"name": value` where the name contains a secret-looking
 * word. Only the value is replaced, so a reader still learns which variable
 * the sender pasted. Two shapes with two stop rules:
 *
 * - A quoted name is a JSON field. Its unquoted value is a number or a
 *   boolean, which never contains a comma, so the value stops at `,`, `;` or
 *   `}` and the rest of a one-line JSON log survives.
 * - A bare name is a shell assignment. Its unquoted value runs to the next
 *   whitespace, because `.env` values contain commas and a stop there would
 *   send the rest of the password.
 *
 * In both shapes the quoted-value forms are tried first (escaped-JSON and
 * plain, closed and open to the end of the line), then the unquoted rule. A
 * quoted name may itself carry escaped quotes (`\"password\"`).
 *
 * The leading lookbehind (not `\b`) means a match can only start at the
 * beginning of a run of name characters. With `\b` the engine retried at every
 * `.`, `_` and `-` inside a long run and rescanned to its end each time, which
 * made redaction quadratic in the size of a pasted blob.
 *
 * Groups: 1 quote, 2 quoted name, 3 separator, 4 value | 5 bare name,
 * 6 separator, 7 value.
 */
const NAMED_SECRET_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])(?:(\\?["'])(${SECRET_NAME})\1(\s*[:=]\s*)(${ANY_QUOTED_VALUE}|[^\s,;}]+)|(${SECRET_NAME})(\s*[:=]\s*)(${ANY_QUOTED_VALUE}|\S+))`,
  "gi",
);

/**
 * `--name value` and `--name=value` on a pasted command line, where the flag
 * name contains a secret-looking word (`--password x`, `--db-password=x`,
 * `--auth-token "x"`). Only the value is replaced. A value cannot itself be a
 * flag, so `--token --other` is left alone. Groups: 1 flag, 2 separator,
 * 3 value.
 */
const SECRET_FLAG = new RegExp(
  String.raw`(?<![\w-])(--[a-z0-9-]*(?:password|passwd|secret|token|api-?key|private-?key|encryption-?key|authorization|(?<![a-z0-9])auth(?![a-z0-9]))[a-z0-9-]*)(=|[ \t]+)(?!-)(${ANY_QUOTED_VALUE}|\S+)`,
  "gi",
);

/**
 * `Authorization: <anything to the end of the line>`, or a quoted value when
 * the header is a JSON field. Upstream covers only `Bearer` and `Basic` with a
 * token-shaped value; `Authorization: token abc123` and an all-letter Bearer
 * token slipped past it. Groups: 1 name and separator, 2 value.
 */
const AUTHORIZATION_HEADER = new RegExp(
  String.raw`(["']?\bAuthorization\b["']?\s*[:=]\s*)(${QUOTED_VALUE}|[^\r\n]+)`,
  "gi",
);

/**
 * `scheme://user:password@host`: `user:password` goes, scheme and host stay.
 * The password runs to the last `@` within the bound, so one containing `/`
 * or `@` (a raw connection string) is still taken whole. The lookbehind stops
 * the scheme from starting mid-word, which kept the pass linear on long
 * dotted runs.
 */
const URL_CREDENTIAL = new RegExp(
  // The username may be empty (`redis://:password@host`).
  String.raw`(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s@/:]*:\S{0,${URL_PASSWORD_MAX_LENGTH}}@`,
  "gi",
);

/** Platform API keys. Only the prefix is documented (`lib/plapi.ts`), so the body is permissive. */
const PLATFORM_API_KEY = /\bak_[A-Za-z0-9_-]{8,}\b/g;

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

/**
 * The lookbehind keeps the local part whole (no match starting mid-word) and
 * refuses one that starts right after `[`, so the `[REDACTED]@host` a URL
 * credential pass leaves behind is not re-read as an address.
 */
const EMAIL =
  /(?<![A-Za-z0-9._%+\-[])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

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
  return new RegExp(`${HOME_DIR_START}${body}(?![\\w])`, "g");
}

/**
 * Each side independently: the upstream scheme pass consumes a closing quote
 * without putting it back, so an already-redacted value can arrive as
 * `"[REDACTED]` with no partner.
 */
function stripQuotes(value: string): string {
  return value.replace(/^["']/, "").replace(/["']$/, "");
}

// ── Entry points ────────────────────────────────────────────────────────────

/**
 * Scrub secrets, home-directory paths and email addresses from `text`.
 *
 * Pass order (see the module comment for the deliberate departures from
 * "upstream first"): the Bearer/Basic pass, so the key-value pattern cannot
 * take the scheme word as the value; the private-key-block pass; the
 * Authorization-header pass; the secret-flag pass; the named-assignment pass; the remaining
 * upstream patterns; URL credentials and
 * `ak_` keys; home directories (the literal `homedir` before the generic
 * shapes, since the sender's text may name another user's home or the CLI may
 * run under `sudo`); and email addresses last, so an address already consumed
 * by a secret pattern is not counted twice. `homedir` is injectable for tests;
 * production callers omit it.
 *
 * Counting: the Authorization-header and named-assignment passes count unless
 * the value is already the marker (quotes stripped); the upstream passes count unless the match already
 * contains the marker, because they overlap by design (`Authorization: Bearer
 * x` is taken by the scheme pass, then the leftover `Authorization:
 * [REDACTED]` by the key-value pass) and the output must stay identical to
 * upstream; every other pass counts each match.
 */
export function redactText(text: string, options: { homedir?: string } = {}): Redaction {
  let redactions = 0;
  const count = (): string => {
    redactions += 1;
    return REDACTED;
  };
  const countUnlessMarked = (match: string): string => {
    if (!match.includes(REDACTED)) redactions += 1;
    return REDACTED;
  };

  let out = text.replace(SCHEME_CREDENTIAL, (match, scheme: string, value: string) => {
    const token = value.replace(/\.+$/, "");
    if (!isCredential(scheme, token)) return match;
    redactions += 1;
    return REDACTED + value.slice(token.length);
  });

  out = out.replace(PRIVATE_KEY_BLOCK, count);

  out = out.replace(AUTHORIZATION_HEADER, (match, name: string, value: string) => {
    if (stripQuotes(value) === REDACTED) return match;
    redactions += 1;
    return `${name}${REDACTED}`;
  });

  out = out.replace(SECRET_FLAG, (match, flag: string, separator: string, value: string) => {
    if (stripQuotes(value) === REDACTED) return match;
    redactions += 1;
    return `${flag}${separator}${REDACTED}`;
  });

  out = out.replace(
    NAMED_SECRET_ASSIGNMENT,
    (
      match: string,
      quote: string | undefined,
      quotedName: string,
      quotedSeparator: string,
      quotedValue: string,
      bareName: string,
      bareSeparator: string,
      bareValue: string,
    ) => {
      const value = quote ? quotedValue : bareValue;
      if (stripQuotes(value) === REDACTED) return match;
      redactions += 1;
      return quote
        ? `${quote}${quotedName}${quote}${quotedSeparator}${REDACTED}`
        : `${bareName}${bareSeparator}${REDACTED}`;
    },
  );

  for (const pattern of UPSTREAM_PATTERNS) out = out.replace(pattern, countUnlessMarked);

  out = out.replace(URL_CREDENTIAL, (_match, scheme: string) => {
    redactions += 1;
    return `${scheme}${REDACTED}@`;
  });
  out = out.replace(PLATFORM_API_KEY, count);

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
 * Prepare one free-text field for sending: bound it, scrub it, cap it.
 *
 * Cuts to `cap` plus {@link REDACTION_MARGIN} first, then scrubs, then cuts
 * to `cap`. The first cut bounds the work whatever the input size, so a
 * pattern that turns out to be slow on large input cannot stall the command.
 * It is safe because the missing-END pass catches a key block the first cut
 * splits, and because the scrub is repeated with a larger bound whenever
 * earlier redactions shrank the text enough to pull the cut's edge inside the
 * cap (see the loop below). Within the first
 * `cap` characters nothing is ever cut before scrubbing: a secret that starts
 * inside the cap and runs past it is still matched whole (it is shorter than
 * the margin) or, if it is a key block the first cut split, taken to the end
 * by the end-of-text alternative of the key-block pattern; a quoted value the
 * first cut split is an unterminated quote and runs to the end of its line.
 * Replacements beyond the bound are not counted, because that text was never
 * read.
 *
 * The final cut never leaves part of a marker: a `[REDACTED]` or `[EMAIL]`
 * that straddles the cap is dropped whole rather than sent as `[REDA`, which a
 * reader could not tell from a secret cut short.
 */
export function redactAndCap(
  text: string,
  cap: number,
  options: { homedir?: string } = {},
): Redaction {
  // The first cut can split a secret at the bound, leaving a fragment too
  // short to match its pattern. That fragment is safe only while it is cut
  // away again by the final cut, which holds when the scrubbed text is still
  // at least `cap + margin` long. Earlier redactions can shrink the text by
  // more than the margin and pull the fragment inside the cap; when that
  // happens, scrub again with a doubled bound until the fragment is beyond
  // the cap or the whole input has been read. The bound doubles, so the
  // total work stays within a small multiple of the input size.
  for (let bound = cap + REDACTION_MARGIN; ; bound *= 2) {
    const wasCut = text.length > bound;
    const scrubbed = redactText(wasCut ? text.slice(0, bound) : text, options);
    if (!wasCut || scrubbed.text.length >= cap + REDACTION_MARGIN) {
      return {
        text: cutKeepingMarkersWhole(scrubbed.text, cap),
        redactions: scrubbed.redactions,
      };
    }
  }
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
