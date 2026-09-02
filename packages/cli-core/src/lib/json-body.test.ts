import { test, expect, describe, afterEach } from "bun:test";
import { CliError, ERROR_CODE } from "./errors.ts";
import { validateJsonBody, type JsonBodyRequest, type JsonBodySource } from "./json-body.ts";

const DATA: JsonBodySource = { kind: "data" };
const USERS: JsonBodyRequest = { endpoint: "/users" };

function rejection(raw: string, source: JsonBodySource = DATA, request = USERS): CliError {
  try {
    validateJsonBody(raw, source, request);
  } catch (error) {
    return error as CliError;
  }
  throw new Error(`expected ${raw} to be rejected`);
}

const originalPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, writable: true });
}
afterEach(() => setPlatform(originalPlatform));

describe("validateJsonBody", () => {
  test("returns the body byte-for-byte when it parses", () => {
    const raw = '  {"first_name": "Alice"}\n';
    expect(validateJsonBody(raw, DATA, USERS)).toBe(raw);
  });

  test("accepts arrays and top-level primitives", () => {
    // The API decodes into a struct, so a non-object is a type error there, not
    // a syntax error — this check only stands in for the syntax check.
    expect(validateJsonBody('[{"id":1}]', DATA, USERS)).toBe('[{"id":1}]');
    expect(validateJsonBody("42", DATA, USERS)).toBe("42");
  });

  test("rejects malformed JSON as a usage error with INVALID_JSON", () => {
    const error = rejection('{"first_name":"Jo"');
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe(ERROR_CODE.INVALID_JSON);
    expect(error.exitCode).toBe(2);
  });

  test("rejects an empty body without echoing a blank Received line", () => {
    const error = rejection("   \n", { kind: "file", path: "empty.json" });
    expect(error.code).toBe(ERROR_CODE.INVALID_JSON);
    expect(error.message).toBe("Invalid JSON in --file empty.json: the body is empty.");
  });

  test("names the source and echoes what arrived", () => {
    setPlatform("linux");
    const error = rejection("{user_id:user_123}");
    expect(error.message).toContain("Invalid JSON in --data");
    expect(error.message).toContain("Received: {user_id:user_123}");
  });

  test("names the file or the pipe when the body did not come from -d", () => {
    expect(rejection("{user_id:x}", { kind: "file", path: "body.json" }).message).toContain(
      "Invalid JSON in --file body.json",
    );
    expect(rejection("{user_id:x}", { kind: "stdin" }).message).toContain(
      "Invalid JSON in the piped request body",
    );
  });

  test("does not blame the shell for ordinary malformed JSON", () => {
    const error = rejection('{"first_name":"Jo"');
    expect(error.code).toBe(ERROR_CODE.INVALID_JSON);
    expect(error.message).not.toContain("shell");
    expect(error.message).not.toContain("--file");
    expect(error.examples).toBeUndefined();
  });

  // A `'` where JSON wants a `"` is someone writing a dict literal, on any
  // platform; the parser's own message already names single quotes.
  test.each<NodeJS.Platform>(["darwin", "win32"])(
    "does not blame the shell for Python-style single-quoted JSON on %s",
    (platform) => {
      setPlatform(platform);
      const error = rejection("{'first_name': 'Alice'}");
      expect(error.code).toBe(ERROR_CODE.INVALID_JSON);
      expect(error.message).not.toContain("shell");
      expect(error.examples).toBeUndefined();
    },
  );

  // Neither went through argument parsing, so stripped quotes are just a typo.
  const NON_SHELL_SOURCES: [string, JsonBodySource][] = [
    ["a file", { kind: "file", path: "body.json" }],
    ["a pipe", { kind: "stdin" }],
  ];
  test.each(NON_SHELL_SOURCES)("does not blame the shell for a body from %s", (_, source) => {
    const error = rejection("{user_id:x}", source);
    expect(error.code).toBe(ERROR_CODE.INVALID_JSON);
    expect(error.message).not.toContain("shell");
    expect(error.examples).toBeUndefined();
  });

  test("truncates a long body in the echo", () => {
    const error = rejection(`{user_id:${"x".repeat(500)}}`);
    expect(error.message).toContain("…");
    expect(error.message).not.toContain("x".repeat(300));
  });

  test("collapses whitespace so the echo stays on one line", () => {
    const error = rejection('{\n  first_name:\n  "Alice"\n}');
    expect(error.message).toContain('Received: { first_name: "Alice" }');
  });

  // --- shell quoting, POSIX ---

  describe("on a POSIX shell", () => {
    test("diagnoses stripped quotes as a missing pair of single quotes", () => {
      setPlatform("darwin");
      // What bash leaves of an unquoted -d {"user_id":"user_123"}.
      const error = rejection("{user_id:user_123}");
      expect(error.code).toBe(ERROR_CODE.INVALID_JSON_SHELL_QUOTING);
      expect(error.message).toContain("Every double quote is missing");
      expect(error.message).toContain("wrap the body in single quotes");
      expect(error.message).not.toContain("PowerShell");
      expect(error.message).not.toContain("cmd.exe");
    });

    test("suggests the quoted form first, then --file", () => {
      setPlatform("linux");
      const error = rejection("[{id:1}]");
      expect(error.examples?.map((e) => e.command)).toEqual([
        `clerk api /users -d '{"key":"value"}'`,
        "clerk api /users --file body.json",
      ]);
    });

    test("still diagnoses a stripped body whose value has an apostrophe", () => {
      setPlatform("darwin");
      expect(rejection("{name:O'Brien}").code).toBe(ERROR_CODE.INVALID_JSON_SHELL_QUOTING);
    });

    test("does not read literal single quotes as cmd.exe", () => {
      setPlatform("darwin");
      const error = rejection('\'{"user_id":"user_123"}\'');
      expect(error.code).toBe(ERROR_CODE.INVALID_JSON);
      expect(error.message).not.toContain("cmd.exe");
    });
  });

  // --- shell quoting, Windows ---

  describe("on Windows", () => {
    test("diagnoses stripped quotes as PowerShell or cmd.exe argument passing", () => {
      setPlatform("win32");
      // What PowerShell before 7.3 leaves of -d '{"user_id":"user_123"}'.
      const error = rejection("{user_id:user_123}");
      expect(error.code).toBe(ERROR_CODE.INVALID_JSON_SHELL_QUOTING);
      expect(error.message).toContain("Every double quote is missing");
      expect(error.message).toContain("PowerShell before 7.3");
      expect(error.message).toContain("cmd.exe");
      expect(error.message).not.toContain("wrap the body in single quotes");
      expect(error.examples?.map((e) => e.command)).toEqual(["clerk api /users --file body.json"]);
    });

    test("diagnoses a body still wrapped in literal single quotes as cmd.exe", () => {
      setPlatform("win32");
      const error = rejection("'{user_id:user_123}'");
      expect(error.code).toBe(ERROR_CODE.INVALID_JSON_SHELL_QUOTING);
      expect(error.message).toContain("literal single quotes");
      expect(error.message).toContain("cmd.exe");
      expect(error.message).not.toContain("PowerShell");
    });

    test("states the remedy in the message, not only in the suggested command", () => {
      setPlatform("win32");
      const error = rejection("{first_name:Alice}");
      expect(error.message).toContain(
        "To fix it, move the body into a file and pass it with --file",
      );
    });
  });

  // --- the suggested command targets the caller's own request ---

  describe("suggested command", () => {
    test("carries an explicit method", () => {
      setPlatform("win32");
      const error = rejection("{first_name:x}", DATA, {
        endpoint: "/users/user_1",
        method: "patch",
      });
      expect(error.examples?.[0]?.command).toBe(
        "clerk api /users/user_1 -X PATCH --file body.json",
      );
    });

    test("carries --fapi, --app, and --instance so it hits the same API", () => {
      setPlatform("win32");
      const error = rejection("{a:b}", DATA, {
        endpoint: "/environment",
        fapi: true,
        app: "app_1",
        instance: "dev",
      });
      expect(error.examples?.[0]?.command).toBe(
        "clerk api --fapi /environment --app app_1 --instance dev --file body.json",
      );
    });

    test("carries --platform", () => {
      setPlatform("win32");
      const error = rejection("{a:b}", DATA, { endpoint: "/applications", platform: true });
      expect(error.examples?.[0]?.command).toBe(
        "clerk api --platform /applications --file body.json",
      );
    });

    // Unquoted, `&` backgrounds the command and `?` is a glob that zsh refuses
    // to leave unmatched, so the suggestion would not hit the same endpoint.
    test("quotes an endpoint with a query string for a POSIX shell", () => {
      setPlatform("darwin");
      const error = rejection("{a:b}", DATA, { endpoint: "/users?limit=1&offset=20" });
      expect(error.examples?.map((e) => e.command)).toEqual([
        `clerk api '/users?limit=1&offset=20' -d '{"key":"value"}'`,
        "clerk api '/users?limit=1&offset=20' --file body.json",
      ]);
    });

    test("quotes an endpoint with a query string for a Windows shell", () => {
      setPlatform("win32");
      const error = rejection("{a:b}", DATA, { endpoint: "/users?limit=1&offset=20" });
      expect(error.examples?.[0]?.command).toBe(
        'clerk api "/users?limit=1&offset=20" --file body.json',
      );
    });

    test.each<[NodeJS.Platform, string]>([
      ["linux", `clerk api /users --app 'o'\\''brien' --file body.json`],
      ["win32", 'clerk api /users --app "o""brien" --file body.json'],
    ])("escapes a quote inside a quoted argument on %s", (platform, command) => {
      setPlatform(platform);
      const error = rejection("{a:b}", DATA, {
        endpoint: "/users",
        app: platform === "win32" ? 'o"brien' : "o'brien",
      });
      expect(error.examples?.at(-1)?.command).toBe(command);
    });
  });
});
