import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as plapi from "../../lib/plapi.ts";
import { CliError, ERROR_CODE, PlapiError } from "../../lib/errors.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import {
  checkSlugTaken,
  parseClerkAppSlug,
  probeClerkApp,
  slugCandidate,
  type ClerkAppSlug,
} from "./clerk-app.ts";

describe("parseClerkAppSlug", () => {
  test.each([
    ["acme", "acme"],
    ["Acme", "acme"],
    ["acme.clerk.app", "acme"],
    ["  my-app-2  ", "my-app-2"],
    ["a".repeat(63), "a".repeat(63)],
  ])("accepts %s as %s", (raw, slug) => {
    expect(parseClerkAppSlug(raw)).toEqual({ ok: true, slug: slug as never });
  });

  test.each(["ab", "-acme", "acme-", "ac_me", "acme.com", "a".repeat(64), ""])(
    "rejects %s",
    (raw) => {
      expect(parseClerkAppSlug(raw).ok).toBe(false);
    },
  );
});

describe("slugCandidate", () => {
  test.each([
    ["My SaaS App", "my-saas-app"],
    ["--Acme Inc.--", "acme-inc"],
    ["ab", "ab"],
    ["日本", "app"],
  ])("turns %s into %s", (label, slug) => {
    expect(slugCandidate(label)).toBe(slug);
  });
});

describe("probeClerkApp", () => {
  useCaptureLog();
  let check: ReturnType<typeof spyOn<typeof plapi, "checkClerkAppSlug">> | undefined;

  afterEach(() => {
    check?.mockRestore();
  });

  test("offers clerk.app with the app name as the default when it is free", async () => {
    check = spyOn(plapi, "checkClerkAppSlug").mockResolvedValue({
      enabled: true,
      valid: true,
      available: true,
      suggestion: null,
    });

    expect(await probeClerkApp("app_1", "My App")).toEqual({
      enabled: true,
      suggestion: "my-app" as never,
    });
    expect(check).toHaveBeenCalledWith("app_1", "my-app");
  });

  test("offers a free variant as the default when the app name is taken", async () => {
    check = spyOn(plapi, "checkClerkAppSlug").mockResolvedValue({
      enabled: true,
      valid: true,
      available: false,
      suggestion: "my-app-3f2a1",
    });

    expect(await probeClerkApp("app_1", "My App")).toEqual({
      enabled: true,
      suggestion: "my-app-3f2a1" as never,
    });
  });

  test("offers the check's suggestion when the app name is too short", async () => {
    check = spyOn(plapi, "checkClerkAppSlug").mockResolvedValue({
      enabled: true,
      valid: false,
      available: false,
      suggestion: "ab-3f2a1",
    });

    expect(await probeClerkApp("app_1", "AB")).toEqual({
      enabled: true,
      suggestion: "ab-3f2a1" as never,
    });
    expect(check).toHaveBeenCalledWith("app_1", "ab");
  });

  test("does not offer clerk.app when the application isn't enabled", async () => {
    check = spyOn(plapi, "checkClerkAppSlug").mockResolvedValue({
      enabled: false,
      valid: false,
      available: false,
      suggestion: null,
    });

    expect(await probeClerkApp("app_1", "My App")).toEqual({ enabled: false });
  });

  test("does not offer clerk.app when the check fails", async () => {
    check = spyOn(plapi, "checkClerkAppSlug").mockRejectedValue(
      new PlapiError(429, JSON.stringify({ errors: [{ code: "too_many_requests" }] }), "x"),
    );

    expect(await probeClerkApp("app_1", "My App")).toEqual({ enabled: false });
  });
});

describe("checkSlugTaken", () => {
  useCaptureLog();
  let check: ReturnType<typeof spyOn<typeof plapi, "checkClerkAppSlug">> | undefined;

  afterEach(() => {
    check?.mockRestore();
  });

  test("stops asking for names when clerk.app was turned off for the application", async () => {
    check = spyOn(plapi, "checkClerkAppSlug").mockResolvedValue({
      enabled: false,
      valid: false,
      available: false,
      suggestion: null,
    });

    const error = await checkSlugTaken("app_1", "acme" as ClerkAppSlug).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(ERROR_CODE.CLERK_APP_NOT_ENABLED);
    expect((error as CliError).message).toContain("No production instance was created.");
  });

  test("reports a malformed name with the format rule, not as taken", async () => {
    check = spyOn(plapi, "checkClerkAppSlug").mockResolvedValue({
      enabled: true,
      valid: false,
      available: false,
      suggestion: "acme-3f2a1",
    });

    const taken = await checkSlugTaken("app_1", "acme" as ClerkAppSlug);

    expect(taken?.message).toStartWith("Use 3 to 63 lowercase letters");
    expect(taken?.message).toEndWith("Try acme-3f2a1.");
    expect(taken?.suggestion).toBe("acme-3f2a1" as ClerkAppSlug);
  });

  test("reports a taken name with the check's suggestion", async () => {
    check = spyOn(plapi, "checkClerkAppSlug").mockResolvedValue({
      enabled: true,
      valid: true,
      available: false,
      suggestion: "acme-3f2a1",
    });

    expect(await checkSlugTaken("app_1", "acme" as ClerkAppSlug)).toEqual({
      message: "acme.clerk.app is taken. Try acme-3f2a1.",
      suggestion: "acme-3f2a1" as ClerkAppSlug,
    });
  });
});
