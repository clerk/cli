import { describe, expect, test } from "bun:test";
import { validateDomain } from "./prompts.ts";

describe("validateDomain", () => {
  test.each([
    ["example.com"],
    ["x.io"],
    ["app.example.co.uk"],
    // Provider domains are legitimate production domains: Clerk serves them
    // through a proxy instead of CNAME records.
    ["my-app.vercel.app"],
    ["my-app.replit.app"],
    // Neither the API nor the dashboard refuses these.
    ["my-app.pages.dev"],
    ["my-app.clerk.app"],
  ])("accepts %s", (domain) => {
    expect(validateDomain(domain)).toBe(true);
  });

  test.each([
    ["", "Enter a domain."],
    ["https://example.com", "without https://"],
    ["http://example.com", "without https://"],
    ["example..com", "Enter a valid domain"],
    ["-example.com", "Enter a valid domain"],
    ["example-.com", "Enter a valid domain"],
  ])("rejects %s", (domain, expected) => {
    expect(validateDomain(domain)).toContain(expected);
  });

  // `POST /instances` creates the instance without running the domain
  // validator every other Clerk surface runs, and nothing in the CLI can
  // delete a production instance afterwards — so these have to be caught here.
  test.each([
    ["demo.netlify.app"],
    ["demo.herokuapp.com"],
    ["demo.fly.dev"],
    ["demo.onrender.com"],
    ["demo.web.app"],
    ["demo.railway.app"],
  ])("rejects the shared hosting domain %s", (domain) => {
    expect(validateDomain(domain)).toContain("shared hosting domain");
  });

  // Mirrors isValidVercelAppDomain in the dashboard: DAPI rejects nested
  // vercel.app hosts with "must be a valid Vercel app domain", and the PLAPI
  // path the CLI uses does not enforce it at all.
  test("rejects a nested vercel.app host", () => {
    expect(validateDomain("preview.my-app.vercel.app")).toContain("my-app.vercel.app");
  });

  test("accepts a vercel.app host with a single label", () => {
    expect(validateDomain("my-app.vercel.app")).toBe(true);
  });
});
