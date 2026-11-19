import { describe, expect, test } from "bun:test";
import { BapiError } from "../../../lib/errors.ts";
import { failureOf } from "./failures.ts";

describe("failureOf", () => {
  test("keeps Clerk's own message", () => {
    const error = new BapiError(
      422,
      JSON.stringify({
        errors: [{ code: "form_identifier_exists", message: "That email is taken." }],
      }),
      new Headers(),
    );
    expect(failureOf(error)).toEqual({ message: "That email is taken.", code: "422" });
  });

  // A gateway's error page fills a terminal and says nothing a summary can use.
  test.each([
    ["an HTML page", "\n<html><head>\n<title>500 Server Error</title></head></html>"],
    ["a doctype", "<!DOCTYPE html><html><body>Bad gateway</body></html>"],
  ])("replaces %s with the status", (_, body) => {
    expect(failureOf(new BapiError(500, body, new Headers()))).toEqual({
      message: "Clerk returned HTTP 500 with no error details",
      code: "500",
    });
  });
});
