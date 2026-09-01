/**
 * Local parse check for raw JSON request bodies that the CLI forwards verbatim
 * (`clerk api -d` / `--file` / piped stdin).
 *
 * Those bodies are the one payload the CLI never builds itself: every other
 * command parses its input and re-serializes with `JSON.stringify`, so a bad
 * value fails on the user's machine. `clerk api` stamps
 * `Content-Type: application/json` on whatever string it is handed, so an
 * unparseable body used to fail only at the API — a round trip later, with a
 * server-side byte offset and no clue as to what mangled it.
 *
 * A `-d` value is the one body that crosses the shell as an argument, and two
 * mangled shapes are recognizable from the value alone:
 *
 *   - Every double quote gone (`{user_id:x}`). In POSIX shells that is an
 *     unquoted `-d {"user_id":"x"}`: the shell consumes the quotes. On Windows
 *     they are lost even from `-d '{"user_id":"x"}'`: PowerShell before 7.3
 *     hands an argument's embedded double quotes to a native program
 *     unescaped, so the program's own command-line parser consumes them.
 *   - Wrapped in literal single quotes (`'{user_id:x}'`). cmd.exe gives `'` no
 *     special meaning, so a POSIX-quoted argument keeps its wrapping quotes
 *     and, as above, loses the double quotes inside.
 *
 * The diagnosis is keyed on the platform, so a Mac user who forgot the quotes
 * is told to add them rather than told about PowerShell. Bodies from `--file`
 * or stdin never went through argument parsing, so they get no shell blame.
 */

import { ERROR_CODE, errorMessage, throwUsageError } from "./errors.ts";
import type { Example } from "./help.ts";

/** Where a raw body came from. Only `data` crossed the shell as an argument. */
export type JsonBodySource = { kind: "data" } | { kind: "file"; path: string } | { kind: "stdin" };

/**
 * The `clerk api` invocation the body belongs to, so a suggested command
 * targets the same request. Values are repeated verbatim in the error, so this
 * carries targeting flags only — never the secret key.
 */
export interface JsonBodyRequest {
  endpoint: string;
  method?: string;
  fapi?: boolean;
  platform?: boolean;
  app?: string;
  instance?: string;
}

interface ShellQuotingDiagnosis {
  cause: string;
  remedy: string;
  examples: Example[];
}

/** How much of a rejected body to echo back, so the error stays readable. */
const PREVIEW_LIMIT = 200;

const FILE_REMEDY =
  "To fix it, move the body into a file and pass it with --file. A file reaches the CLI " +
  "exactly as written, whatever the shell does to arguments.";

function sourceLabel(source: JsonBodySource): string {
  switch (source.kind) {
    case "data":
      return "--data";
    case "file":
      return `--file ${source.path}`;
    case "stdin":
      return "the piped request body";
  }
}

/** One-line rendering of what actually arrived, for the "Received:" line. */
function preview(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > PREVIEW_LIMIT ? `${collapsed.slice(0, PREVIEW_LIMIT)}…` : collapsed;
}

/**
 * `clerk api …` with the caller's own targeting flags and `body` in place of
 * the original `-d`, so the suggestion is runnable as printed. The method is
 * repeated explicitly; without one, a body makes `clerk api` default to POST.
 */
function apiCommand(request: JsonBodyRequest, body: string): string {
  const parts = ["clerk api"];
  if (request.fapi) parts.push("--fapi");
  if (request.platform) parts.push("--platform");
  parts.push(request.endpoint);
  if (request.method) parts.push("-X", request.method.toUpperCase());
  if (request.app) parts.push("--app", request.app);
  if (request.instance) parts.push("--instance", request.instance);
  parts.push(body);
  return parts.join(" ");
}

/**
 * Name the shell quoting behind a `-d` value that failed to parse, when its
 * shape gives it away. Returns undefined for ordinary malformed JSON.
 */
function diagnoseShellQuoting(
  raw: string,
  request: JsonBodyRequest,
): ShellQuotingDiagnosis | undefined {
  const trimmed = raw.trim();
  const windows = process.platform === "win32";
  const fileExample: Example = {
    command: apiCommand(request, "--file body.json"),
    description: "The same request, with the body read from a file",
  };

  // A JSON object or array with no `"` anywhere had its quotes stripped: any
  // object key, and any string value, would have to carry a pair. A `'` right
  // where JSON would put a `"` is Python-style quoting instead, which no shell
  // produces — the parse error already says single quotes are not allowed.
  const quotesStripped =
    /^[{[]/.test(trimmed) && !trimmed.includes('"') && !/[{[,:]\s*'/.test(trimmed);
  if (quotesStripped) {
    if (windows) {
      return {
        cause:
          "Every double quote is missing, so the shell removed them before the CLI saw the " +
          "value. PowerShell before 7.3 passes the double quotes inside an argument to a native " +
          "program unescaped, so its command-line parser consumes them; cmd.exe does the same.",
        remedy: FILE_REMEDY,
        examples: [fileExample],
      };
    }
    return {
      cause:
        "Every double quote is missing, so the shell removed them before the CLI saw the " +
        "value. Without quotes around the whole body, the shell treats the double quotes " +
        "inside it as its own and strips them.",
      remedy:
        "To fix it, wrap the body in single quotes so the shell passes it through untouched, " +
        "or move it into a file and pass it with --file.",
      examples: [
        {
          command: apiCommand(request, `-d '{"key":"value"}'`),
          description: "Single quotes keep the shell out of the body",
        },
        fileExample,
      ],
    };
  }

  // POSIX-style `-d '{"a":1}'` reaching us with its wrapping quotes intact.
  // Only cmd.exe does this; every other shell consumes the single quotes.
  if (windows && trimmed.length > 1 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return {
      cause:
        "The body arrived wrapped in literal single quotes. cmd.exe gives ' no special " +
        "meaning, so a POSIX-quoted -d '{...}' keeps its wrapping quotes, and the double " +
        "quotes inside are consumed by the command-line parser.",
      remedy: FILE_REMEDY,
      examples: [fileExample],
    };
  }

  return undefined;
}

/**
 * Parse-check a raw request body before it goes out on the wire, throwing a
 * usage error instead of letting the API reject it.
 *
 * Returns the body unchanged — callers keep forwarding the exact bytes the user
 * supplied, so a valid payload is never reformatted on its way through.
 *
 * Accepts any syntactically valid JSON, including top-level primitives: the
 * goal is to catch what the API's decoder would report as a syntax error, not
 * to second-guess an endpoint's schema.
 *
 * A `-d` body that the shell visibly mangled is reported under
 * `INVALID_JSON_SHELL_QUOTING`, with the cause and a runnable way around it,
 * so those rejections can be counted apart from ordinary typos.
 */
export function validateJsonBody(
  raw: string,
  source: JsonBodySource,
  request: JsonBodyRequest,
): string {
  const label = sourceLabel(source);

  if (!raw.trim()) {
    throwUsageError(
      `Invalid JSON in ${label}: the body is empty.`,
      undefined,
      ERROR_CODE.INVALID_JSON,
    );
  }

  try {
    JSON.parse(raw);
    return raw;
  } catch (error) {
    const detail =
      `Invalid JSON in ${label}: ${errorMessage(error)}\n\n` + `  Received: ${preview(raw)}`;

    // Ordinary malformed JSON — a missing brace, a trailing comma. The parse
    // message and the echo above already say what to change, and suggesting a
    // different way to pass the same broken body would only be noise.
    const diagnosis = source.kind === "data" ? diagnoseShellQuoting(raw, request) : undefined;
    if (!diagnosis) {
      throwUsageError(detail, undefined, ERROR_CODE.INVALID_JSON);
    }

    throwUsageError(
      `${detail}\n\n${diagnosis.cause}\n\n${diagnosis.remedy}`,
      undefined,
      ERROR_CODE.INVALID_JSON_SHELL_QUOTING,
      diagnosis.examples,
    );
  }
}
