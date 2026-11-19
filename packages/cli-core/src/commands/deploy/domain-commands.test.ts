import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as plapi from "../../lib/plapi.ts";
import * as prompts from "../../lib/prompts.ts";
import { _setConfigDir, setProfile } from "../../lib/config.ts";
import { CliError, ERROR_CODE, EXIT_CODE, PlapiError, UserAbortError } from "../../lib/errors.ts";
import { _resetMode, setMode } from "../../mode.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import { addDomain, listDomainsCommand, removeDomain } from "./domain-commands.ts";

type Domain = plapi.ApplicationDomain;

function domain(name: string, extra: Partial<Domain> = {}): Domain {
  return {
    object: "domain",
    id: `dmn_${name}`,
    name,
    is_satellite: false,
    is_provider_domain: false,
    is_clerk_managed: false,
    is_web_host: false,
    frontend_api_url: `https://clerk.${name}`,
    development_origin: "",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...extra,
  };
}

const managed = domain("acme.clerk.app", { is_clerk_managed: true, is_primary: true });
const hosting = domain("acme.netlify.app", {
  is_web_host: true,
  proxy_url: "https://acme.netlify.app/__clerk",
  frontend_api_url: "https://acme.netlify.app/__clerk",
  session_token_issuer: "https://acme.netlify.app/__clerk",
});

function plapiError(status: number, code: string, meta: Record<string, unknown> = {}) {
  return new PlapiError(status, JSON.stringify({ errors: [{ code, meta }] }), "x");
}

describe("clerk deploy domain commands", () => {
  const captured = useCaptureLog();
  let tempDir = "";
  let spies: { mockRestore(): void }[] = [];
  let list: ReturnType<typeof spyOn<typeof plapi, "listApplicationDomains">>;
  let create: ReturnType<typeof spyOn<typeof plapi, "createApplicationDomain">>;
  let remove: ReturnType<typeof spyOn<typeof plapi, "deleteApplicationDomain">>;
  let confirm: ReturnType<typeof spyOn<typeof prompts, "confirm">>;

  function listReturns(domains: Domain[]) {
    list.mockResolvedValue({ data: domains, total_count: domains.length });
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-domains-"));
    _setConfigDir(tempDir);
    await setProfile(process.cwd(), {
      workspaceId: "workspace_1",
      appId: "app_1",
      instances: { development: "ins_dev", production: "ins_prod" },
    } as never);
    list = spyOn(plapi, "listApplicationDomains");
    create = spyOn(plapi, "createApplicationDomain");
    remove = spyOn(plapi, "deleteApplicationDomain").mockResolvedValue(undefined);
    confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    spies = [
      list,
      create,
      remove,
      confirm,
      spyOn(plapi, "fetchApplication").mockResolvedValue({
        application_id: "app_1",
        name: "Acme",
        instances: [
          { instance_id: "ins_dev", environment_type: "development", publishable_key: "pk_test" },
          { instance_id: "ins_prod", environment_type: "production", publishable_key: "pk_live" },
        ],
      }),
    ];
    setMode("agent");
    process.exitCode = 0;
  });

  afterEach(async () => {
    for (const spy of spies) spy.mockRestore();
    _resetMode();
    _setConfigDir(undefined);
    process.exitCode = 0;
    await rm(tempDir, { recursive: true, force: true });
  });

  const report = () => JSON.parse(captured.out) as Record<string, unknown>;

  describe("add-domain", () => {
    test("adds a hosting domain by name and reports how to serve the proxy", async () => {
      listReturns([managed]);
      create.mockResolvedValue(hosting);

      await addDomain("HTTPS://Acme.Netlify.app/");

      expect(create).toHaveBeenCalledWith("app_1", { name: "acme.netlify.app" });
      expect(report()).toMatchObject({
        domain: "acme.netlify.app",
        kind: "hosting",
        added: true,
        proxyUrl: "https://acme.netlify.app/__clerk",
        docsUrl: "https://clerk.com/docs/guides/dashboard/dns-domains/proxy-fapi",
      });
      expect(report().proxySetup).toContain(
        "Next.js, Express, Fastify and Hono: turn on frontendApiProxy in the Clerk middleware.",
      );
      expect(report().proxySetup).toContain(
        "Hosted sign-in pages don't work on a hosting domain. Add your own sign-in page with the <SignIn /> component and set signInUrl to it. " +
          "In Next.js, set NEXT_PUBLIC_CLERK_SIGN_IN_URL.",
      );
      expect(report().nextAction).toContain(
        "Serve the Clerk proxy at https://acme.netlify.app/__clerk",
      );
      expect(report().notes).toEqual([
        "Your app on acme.netlify.app uses the same Clerk setup as your primary domain.",
        "A route you add to your app passes sign-in requests to Clerk, so users, sign-in options and emails are all shared.",
        "If your backend checks the session token's issuer, also accept https://acme.netlify.app/__clerk.",
        "Passkeys don't work on hosting domains yet. Passkeys in your native apps aren't affected.",
      ]);
      expect(process.exitCode).toBe(0);
    });

    test("prints the proxy steps for a person", async () => {
      setMode("human");
      listReturns([managed]);
      create.mockResolvedValue(hosting);

      await addDomain("acme.netlify.app");

      expect(captured.err).toContain(
        "acme.netlify.app is on a hosting provider, so it's added as a hosting domain. It can't be made primary.",
      );
      expect(captured.err).toContain("Proxy URL:  https://acme.netlify.app/__clerk");
      expect(captured.err).not.toContain("frontend-api.clerk.dev");
      expect(captured.err).not.toContain("https://clerk.acme.clerk.app");
      expect(captured.err).toContain("NEXT_PUBLIC_CLERK_SIGN_IN_URL");
      expect(captured.err).toContain("NEXT_PUBLIC_CLERK_PROXY_URL");
      expect(captured.err).toContain("Passkeys don't work on hosting domains yet.");
      expect(captured.err).toContain(
        "A route you add to your app passes sign-in requests to Clerk, so users, sign-in options and emails are all shared.",
      );
      expect(captured.err).toContain(
        "Proxy guide: https://clerk.com/docs/guides/dashboard/dns-domains/proxy-fapi",
      );
      expect(captured.err).not.toMatch(/\bsite\b(?! with no server)/);
      expect(captured.out).toBe("");
    });

    test("adds a domain you own by name and reports its DNS records and the switch", async () => {
      listReturns([managed, hosting]);
      create.mockResolvedValue(
        domain("example.com", {
          cname_targets: [
            { host: "clerk.example.com", value: "frontend-api.clerk.services", required: true },
          ],
        }),
      );

      await addDomain("Example.com");

      expect(create).toHaveBeenCalledWith("app_1", { name: "example.com" });
      expect(report()).toEqual({
        domain: "example.com",
        kind: "custom",
        added: true,
        primary: false,
        dnsRecords: [
          {
            type: "CNAME",
            host: "clerk.example.com",
            value: "frontend-api.clerk.services",
            required: true,
          },
        ],
        nextAction:
          "Add the DNS records for example.com at your DNS provider. Clerk checks them on its own. " +
          "Make example.com primary once it's configured with `clerk deploy use-domain example.com`. " +
          "It says which of DNS, SSL and email DNS are still pending, and switches once they all pass. " +
          "If you use your own OAuth credentials, add https://clerk.example.com/v1/oauth_callback " +
          "to each provider's app now, next to the redirect URL it has. Keep both, so sign-in works before and after the switch.",
      });
      expect(process.exitCode).toBe(0);
    });

    test("prints the DNS records of a domain you own for a person", async () => {
      setMode("human");
      listReturns([managed]);
      create.mockResolvedValue(
        domain("example.com", {
          cname_targets: [
            { host: "clerk.example.com", value: "frontend-api.clerk.services", required: true },
          ],
        }),
      );

      await addDomain("example.com");

      expect(captured.err).toContain("Added example.com");
      expect(captured.err).toContain("Host:  clerk.example.com");
      expect(captured.err).toContain("Value: frontend-api.clerk.services");
      expect(captured.err).toContain("`clerk deploy use-domain example.com`");
      expect(captured.err).not.toContain("Proxy URL");
    });

    test("routes by what Clerk created, not by the name", async () => {
      listReturns([managed]);
      create.mockResolvedValue(domain("acme.vercel.app", { is_web_host: false }));

      await addDomain("acme.vercel.app");

      expect(report()).toMatchObject({ domain: "acme.vercel.app", kind: "custom" });
    });

    test.each([
      ["a hosting domain", "acme.vercel.app"],
      ["a domain you own", "acme.com"],
    ])("adds %s without asking", async (_label, name) => {
      setMode("human");
      listReturns([managed]);
      create.mockResolvedValue(domain(name));

      await addDomain(name);

      expect(confirm).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledWith("app_1", { name });
    });

    test.each([
      ["a hosting domain", hosting, "hosting"],
      ["a domain you own", domain("example.com"), "custom"],
    ] as const)("a rerun reports %s again without adding it", async (_label, existing, kind) => {
      listReturns([managed, existing]);

      await addDomain(existing.name);

      expect(create).not.toHaveBeenCalled();
      expect(report()).toMatchObject({ domain: existing.name, kind, added: false });
    });

    test("a rerun after the switch says the domain you own is already primary", async () => {
      listReturns([
        domain("acme.clerk.app", { is_clerk_managed: true }),
        domain("example.com", { is_primary: true, cname_targets: [] }),
      ]);

      await addDomain("example.com");

      expect(create).not.toHaveBeenCalled();
      expect(report()).toMatchObject({
        kind: "custom",
        added: false,
        primary: true,
        dnsRecords: [],
        nextAction: "example.com is already production's primary domain. Nothing changed.",
      });
    });

    test("adds a hosting domain after the switch to a domain you own", async () => {
      listReturns([
        domain("acme.clerk.app", { is_clerk_managed: true }),
        domain("example.com", { is_primary: true }),
      ]);
      create.mockResolvedValue(hosting);

      await addDomain("acme.netlify.app");

      expect(create).toHaveBeenCalledWith("app_1", { name: "acme.netlify.app" });
    });

    test.each([
      [
        "added and not primary",
        domain("example.com"),
        "You already added example.com, and production can have only one domain you own beside clerk.app. Nothing was added. " +
          "Run `clerk deploy use-domain example.com` to make it primary.",
      ],
      [
        "primary",
        domain("example.com", { is_primary: true }),
        "Production already uses example.com, and it can have only one domain you own beside clerk.app. Nothing was added.",
      ],
    ])(
      "names the domain you own when Clerk refuses a second while the first is %s",
      async (_label, own, message) => {
        listReturns([domain("acme.clerk.app", { is_clerk_managed: true }), own, hosting]);
        create.mockRejectedValue(plapiError(422, "custom_domain_beside_clerk_managed_exists"));

        const error = await addDomain("example.org").catch((e: unknown) => e);

        expect(create).toHaveBeenCalledWith("app_1", { name: "example.org" });
        expect((error as CliError).code).toBe(ERROR_CODE.CUSTOM_DOMAIN_BESIDE_CLERK_MANAGED_EXISTS);
        expect((error as CliError).message).toBe(message);
      },
    );

    test.each([
      ["a domain you own", "example.org"],
      ["a hosting domain", "acme.vercel.app"],
    ])("refuses %s on an app with no clerk.app domain", async (_label, name) => {
      listReturns([domain("example.com", { is_primary: true })]);

      const error = await addDomain(name).catch((e: unknown) => e);

      expect((error as CliError).code).toBe(ERROR_CODE.NO_CLERK_APP_DOMAIN);
      expect((error as CliError).exitCode).toBe(EXIT_CODE.GENERAL);
      expect((error as CliError).message).toContain(
        "production uses example.com with no clerk.app domain. Nothing was added.",
      );
      expect((error as CliError).message).toContain("/apps/app_1/instances/ins_prod/domains");
      expect(create).not.toHaveBeenCalled();
    });

    test.each(["acme.pages.dev", "acme.github.io", "acme.railway.app", "acme.workers.dev"])(
      "refuses %s, a hosting provider Clerk doesn't support, before any request",
      async (name) => {
        const error = await addDomain(`https://${name}/`).catch((e: unknown) => e);

        expect((error as CliError).code).toBe(ERROR_CODE.KNOWN_HOSTING_DOMAIN);
        expect((error as CliError).exitCode).toBe(EXIT_CODE.USAGE);
        expect((error as CliError).message).toContain(
          `${name} is on a hosting provider Clerk doesn't support yet. Nothing was added.`,
        );
        expect((error as CliError).message).toContain("netlify.app");
        expect(list).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
      },
    );

    test.each(["a.b.clerk.app", "ab.clerk.app"])(
      "refuses %s, not one valid clerk.app name, before any request",
      async (name) => {
        const error = await addDomain(name).catch((e: unknown) => e);

        expect((error as CliError).code).toBe(ERROR_CODE.CLERK_APP_SLUG_INVALID);
        expect((error as CliError).exitCode).toBe(EXIT_CODE.USAGE);
        expect(list).not.toHaveBeenCalled();
      },
    );

    test("refuses a clerk.app domain on production on a domain you own", async () => {
      listReturns([domain("example.com", { is_primary: true })]);

      const error = await addDomain("Acme.clerk.app").catch((e: unknown) => e);

      expect((error as CliError).code).toBe(ERROR_CODE.NO_CLERK_APP_DOMAIN);
      expect(create).not.toHaveBeenCalled();
    });

    test("refuses a second clerk.app domain before any request", async () => {
      listReturns([managed]);

      const error = await addDomain("other.clerk.app").catch((e: unknown) => e);

      expect((error as CliError).code).toBe(ERROR_CODE.CLERK_APP_DOMAIN_EXISTS);
      expect((error as CliError).message).toBe(
        "This instance already has a clerk.app domain. Nothing was added.",
      );
      expect(create).not.toHaveBeenCalled();
    });

    test("says a clerk.app domain production moved off can't be primary again", async () => {
      listReturns([{ ...managed, is_primary: false }, domain("example.com", { is_primary: true })]);

      await addDomain("acme.clerk.app");

      expect(create).not.toHaveBeenCalled();
      expect(report()).toEqual({
        domain: "acme.clerk.app",
        kind: "clerk_app",
        added: false,
        primary: false,
        nextAction:
          "acme.clerk.app is this application's clerk.app domain. Production moved off it, and it can't become the primary domain again.",
      });
    });

    test("refuses a satellite domain of the application", async () => {
      listReturns([managed, domain("example.com", { is_satellite: true })]);

      const error = await addDomain("example.com").catch((e: unknown) => e);

      expect((error as CliError).code).toBe(ERROR_CODE.DEPLOY_DOMAIN_CONFLICT);
      expect(create).not.toHaveBeenCalled();
    });

    test.each([
      [
        403,
        "feature_not_enabled",
        {},
        ERROR_CODE.CLERK_APP_NOT_ENABLED,
        "can't use clerk.app domains",
      ],
      [
        422,
        "known_hosting_domain",
        {},
        ERROR_CODE.KNOWN_HOSTING_DOMAIN,
        "acme.netlify.app is on a hosting provider Clerk doesn't support yet",
      ],
      [
        422,
        "form_identifier_exists",
        { param_name: "name" },
        ERROR_CODE.DOMAIN_TAKEN,
        "already added to a Clerk instance",
      ],
      [
        422,
        "custom_domain_beside_clerk_managed_exists",
        {},
        ERROR_CODE.CUSTOM_DOMAIN_BESIDE_CLERK_MANAGED_EXISTS,
        "Run `clerk deploy domains` to see it.",
      ],
    ] as [number, string, Record<string, unknown>, string, string][])(
      "maps %i %s",
      async (status, code, meta, cliCode, message) => {
        listReturns([managed]);
        create.mockRejectedValue(plapiError(status, code, meta));

        const error = await addDomain("acme.netlify.app").catch((e: unknown) => e);

        expect((error as CliError).code).toBe(cliCode as never);
        expect((error as CliError).message).toContain(message);
      },
    );

    test.each(["not a host", "acme.netlify.app/login"])(
      "rejects %s before any request",
      async (raw) => {
        const error = await addDomain(raw).catch((e: unknown) => e);

        expect((error as CliError).exitCode).toBe(EXIT_CODE.USAGE);
        expect(list).not.toHaveBeenCalled();
      },
    );

    test("stops before any domain request without a production instance", async () => {
      spies.push(
        spyOn(plapi, "fetchApplication").mockResolvedValue({
          application_id: "app_1",
          name: "Acme",
          instances: [
            { instance_id: "ins_dev", environment_type: "development", publishable_key: "pk" },
          ],
        }),
      );

      const error = await addDomain("acme.netlify.app").catch((e: unknown) => e);

      expect((error as CliError).code).toBe(ERROR_CODE.DEPLOY_INSTANCE_UNRESOLVED);
      expect(list).not.toHaveBeenCalled();
    });
  });

  describe("domains", () => {
    const own = domain("example.com");

    test("lists every domain with its kind for an agent", async () => {
      listReturns([managed, own, hosting, domain("satellite.dev", { is_satellite: true })]);

      await listDomainsCommand();

      expect(report()).toEqual({
        domains: [
          {
            domain: "acme.clerk.app",
            kind: "clerk_app",
            primary: true,
            proxyUrl: null,
          },
          {
            domain: "example.com",
            kind: "custom",
            primary: false,
            proxyUrl: null,
          },
          {
            domain: "acme.netlify.app",
            kind: "hosting",
            primary: false,
            proxyUrl: "https://acme.netlify.app/__clerk",
          },
          {
            domain: "satellite.dev",
            kind: "satellite",
            primary: false,
            proxyUrl: null,
          },
        ],
      });
    });

    test("lists every domain in one table for a person", async () => {
      setMode("human");
      listReturns([managed, hosting, own]);

      await listDomainsCommand();

      const table = captured.err.slice(captured.err.indexOf("Domains\n"));
      const lines = table.split("\n").filter((line) => line.trim() !== "");
      expect(lines).toEqual([
        "Domains",
        "  acme.clerk.app     Clerk-managed   Primary",
        "  acme.netlify.app   Hosting",
        "  example.com        Custom",
      ]);
    });
  });

  describe("remove-domain", () => {
    const replaced = domain("acme.clerk.app", { is_clerk_managed: true });
    const ownPrimary = domain("example.com", { is_primary: true });
    const withoutClerkApp = [ownPrimary, domain("www.example.com")];

    test("asks a person, then shuts down the clerk.app domain a domain you own replaced", async () => {
      setMode("human");
      listReturns([replaced, ownPrimary, hosting]);

      await removeDomain("acme.clerk.app");

      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            "Remove acme.clerk.app? Removing acme.clerk.app shuts it down for good, so builds that still use it stop working.",
        }),
      );
      expect(remove).toHaveBeenCalledWith("app_1", "dmn_acme.clerk.app");
      expect(captured.err).toContain("Removed acme.clerk.app");
    });

    test("removes a domain that isn't primary on an app without clerk.app", async () => {
      listReturns(withoutClerkApp);

      await removeDomain("www.example.com", { yes: true });

      expect(remove).toHaveBeenCalledWith("app_1", "dmn_www.example.com");
      expect(report()).toEqual({ domain: "www.example.com", removed: true });
    });

    test("deletes nothing when the person declines", async () => {
      setMode("human");
      listReturns(withoutClerkApp);
      confirm.mockResolvedValue(false);

      await expect(removeDomain("www.example.com")).rejects.toBeInstanceOf(UserAbortError);
      expect(remove).not.toHaveBeenCalled();
    });

    test("needs --yes from an agent", async () => {
      listReturns([replaced, ownPrimary]);

      const error = await removeDomain("acme.clerk.app").catch((e: unknown) => e);

      expect((error as CliError).exitCode).toBe(EXIT_CODE.USAGE);
      expect((error as CliError).message).toContain("Pass --yes to confirm");
      expect(remove).not.toHaveBeenCalled();

      await removeDomain("acme.clerk.app", { yes: true });

      expect(remove).toHaveBeenCalledWith("app_1", "dmn_acme.clerk.app");
      expect(report()).toEqual({ domain: "acme.clerk.app", removed: true });
    });

    test("succeeds without a request when the domain is already gone", async () => {
      listReturns([managed]);

      await removeDomain("acme.netlify.app");

      expect(remove).not.toHaveBeenCalled();
      expect(report()).toEqual({ domain: "acme.netlify.app", removed: false });
    });

    test.each([
      ["the primary clerk.app domain", [managed], "acme.clerk.app", "production's primary domain"],
      [
        "a primary domain you own",
        [replaced, ownPrimary],
        "example.com",
        "production's primary domain",
      ],
      [
        "a hosting domain on an app with clerk.app",
        [managed, hosting],
        "acme.netlify.app",
        "Domains of this application can't be deleted, except its clerk.app domain once another domain is primary.",
      ],
      [
        "a domain you own beside clerk.app",
        [managed, domain("example.com")],
        "example.com",
        "Domains of this application can't be deleted, except its clerk.app domain once another domain is primary.",
      ],
    ] as [string, Domain[], string, string][])(
      "refuses %s",
      async (_label, domains, name, message) => {
        listReturns(domains);

        const error = await removeDomain(name, { yes: true }).catch((e: unknown) => e);

        expect((error as CliError).code).toBe(ERROR_CODE.DOMAIN_NOT_REMOVABLE);
        expect((error as CliError).message).toContain(message);
        expect((error as CliError).message).toContain("Nothing changed.");
        expect(remove).not.toHaveBeenCalled();
      },
    );

    test.each([
      ["domain_deletion_not_allowed", "can't be deleted, except its clerk.app domain"],
      ["operation_not_allowed_on_primary_domain", "production's primary domain"],
    ])("maps Clerk's 403 %s", async (code, message) => {
      listReturns(withoutClerkApp);
      remove.mockRejectedValue(plapiError(403, code));

      const error = await removeDomain("www.example.com", { yes: true }).catch((e: unknown) => e);

      expect((error as CliError).code).toBe(ERROR_CODE.DOMAIN_NOT_REMOVABLE);
      expect((error as CliError).message).toContain(message);
    });
  });
});
