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
import { createProgram } from "../../cli-program.ts";
import { planUseDomain, useDomain } from "./use-domain.ts";

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

const ready = { dns: true, ssl: true, email: true, email_links: true };
// PLAPI sends readiness on every non-satellite domain of an application that may
// switch its primary domain, and on none for one that may not.
const managed = domain("acme.clerk.app", {
  is_clerk_managed: true,
  is_primary: true,
  make_primary_readiness: ready,
});
const switchingOff = domain("acme.clerk.app", { is_clerk_managed: true, is_primary: true });
const records = [
  { host: "clerk.example.com", value: "frontend-api.clerk.services", required: true },
  { host: "clkmail.example.com", value: "mail.example.com.clerk.services", required: true },
];

const DOMAINS_URL = "https://dashboard.clerk.com/apps/app_1/instances/ins_prod/domains";

describe("planUseDomain", () => {
  test.each([
    [
      "the primary",
      [managed, domain("example.com", { is_primary: true, make_primary_readiness: ready })],
      "already_primary",
    ],
    [
      "failing a check",
      [managed, domain("example.com", { make_primary_readiness: { ...ready, ssl: false } })],
      "not_ready",
    ],
    [
      "passing every check",
      [managed, domain("example.com", { make_primary_readiness: ready })],
      "ready",
    ],
    [
      "served through the Clerk proxy",
      [
        managed,
        domain("example.com", {
          proxy_url: "https://example.com/__clerk",
          make_primary_readiness: ready,
        }),
      ],
      "ready",
    ],
    [
      "on a provider's name that the API doesn't mark as a hosting domain",
      [managed, domain("example.com", { is_provider_domain: true, make_primary_readiness: ready })],
      "ready",
    ],
  ] as [string, Domain[], string][])("a domain %s plans %s", (_label, domains, kind) => {
    expect(planUseDomain(domains, "example.com", DOMAINS_URL).kind).toBe(kind as never);
  });

  test.each([
    [
      "a satellite",
      domain("example.com", { is_satellite: true }),
      ERROR_CODE.DEPLOY_DOMAIN_CONFLICT,
      "is a satellite domain of this application",
    ],
    [
      "a hosting domain",
      domain("acme.netlify.app", {
        is_web_host: true,
        proxy_url: "https://acme.netlify.app/__clerk",
        make_primary_readiness: ready,
      }),
      ERROR_CODE.WEB_HOST_CANNOT_BE_PRIMARY,
      "with a domain you own instead",
    ],
  ] as [string, Domain, string, string][])(
    "refuses %s beside clerk.app",
    (_label, target, code, message) => {
      const error = (() => {
        try {
          return planUseDomain([managed, target], target.name, DOMAINS_URL);
        } catch (e) {
          return e;
        }
      })();

      expect((error as CliError).code).toBe(code as never);
      expect((error as CliError).exitCode).toBe(EXIT_CODE.USAGE);
      expect((error as CliError).message).toContain(message);
    },
  );
});

describe("clerk deploy use-domain", () => {
  const captured = useCaptureLog();
  let tempDir = "";
  let spies: { mockRestore(): void }[] = [];
  let list: ReturnType<typeof spyOn<typeof plapi, "listApplicationDomains">>;
  let create: ReturnType<typeof spyOn<typeof plapi, "createApplicationDomain">>;
  let makePrimary: ReturnType<typeof spyOn<typeof plapi, "makeApplicationDomainPrimary">>;
  let dnsCheck: ReturnType<typeof spyOn<typeof plapi, "triggerApplicationDomainDNSCheck">>;
  let confirm: ReturnType<typeof spyOn<typeof prompts, "confirm">>;

  function listReturns(...pages: Domain[][]) {
    for (const page of pages) {
      list.mockResolvedValueOnce({ data: page, total_count: page.length });
    }
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-use-domain-"));
    _setConfigDir(tempDir);
    await setProfile(process.cwd(), {
      workspaceId: "workspace_1",
      appId: "app_1",
      instances: { development: "ins_dev", production: "ins_prod" },
    } as never);
    list = spyOn(plapi, "listApplicationDomains");
    create = spyOn(plapi, "createApplicationDomain");
    makePrimary = spyOn(plapi, "makeApplicationDomainPrimary");
    dnsCheck = spyOn(plapi, "triggerApplicationDomainDNSCheck").mockResolvedValue(
      {} as plapi.TriggerDNSCheckResponse,
    );
    confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    spies = [
      list,
      create,
      makePrimary,
      dnsCheck,
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

  test("refuses a domain it hasn't added and points at add-domain, changing nothing", async () => {
    listReturns([managed]);

    const error = await useDomain("Example.com", { yes: true }).catch((e: unknown) => e);

    expect((error as CliError).code).toBe(ERROR_CODE.DOMAIN_NOT_FOUND);
    expect((error as CliError).message).toBe(
      "example.com isn't one of this application's domains yet. Nothing changed. " +
        "Add it with `clerk deploy add-domain example.com`, then run this command again.",
    );
    expect(create).not.toHaveBeenCalled();
    expect(makePrimary).not.toHaveBeenCalled();
  });

  test("starts a new DNS check for a domain that isn't ready and reports what is missing", async () => {
    listReturns([
      managed,
      domain("example.com", {
        cname_targets: records,
        make_primary_readiness: { ...ready, ssl: false },
      }),
    ]);

    await useDomain("example.com");

    expect(dnsCheck).toHaveBeenCalledWith("app_1", "dmn_example.com");
    expect(report().pendingDnsRecords).toEqual([]);
    expect(report().nextAction).toContain("Still pending: SSL.");
    expect(report().nextAction).toContain("Clerk is checking it again");
    expect(makePrimary).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_CODE.GENERAL);
  });

  test.each([
    ["an existing domain", () => listReturns([switchingOff, domain("example.com")])],
    ["a domain it hasn't added", () => listReturns([switchingOff])],
  ] as [string, () => void][])(
    "refuses before changing anything when the API reports no readiness for %s",
    async (_label, arrange) => {
      setMode("human");
      arrange();

      const error = await useDomain("example.com").catch((e: unknown) => e);

      expect((error as CliError).code).toBe(ERROR_CODE.CLERK_APP_NOT_ENABLED);
      expect(create).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(makePrimary).not.toHaveBeenCalled();
    },
  );

  test("a clerk.app domain that isn't ready waits on SSL without a DNS check", async () => {
    listReturns([
      { ...managed, is_primary: false, make_primary_readiness: { ...ready, ssl: false } },
      domain("example.com", { is_primary: true, make_primary_readiness: ready }),
    ]);

    await useDomain("acme.clerk.app");

    expect(dnsCheck).not.toHaveBeenCalled();
    expect(report().nextAction).toContain("Still pending: SSL.");
    expect(report().nextAction).toContain("Clerk is issuing its SSL certificate");
    expect(report().nextAction).not.toContain("checking it again");
    expect(report().nextAction).not.toContain("Propagation");
    expect(process.exitCode).toBe(EXIT_CODE.GENERAL);
  });

  test("refuses to switch back to clerk.app while email links are on", async () => {
    listReturns([
      { ...managed, is_primary: false, make_primary_readiness: { ...ready, email_links: false } },
      domain("example.com", { is_primary: true, make_primary_readiness: ready }),
    ]);

    const error = await useDomain("acme.clerk.app", { yes: true }).catch((e: unknown) => e);

    expect((error as CliError).code).toBe(ERROR_CODE.CLERK_MANAGED_DOMAIN_REFUSES_EMAIL_LINKS);
    expect((error as CliError).message).toContain("Turn off email links");
    expect(makePrimary).not.toHaveBeenCalled();
  });

  test("an agent can't switch without --yes", async () => {
    listReturns([managed, domain("example.com", { make_primary_readiness: ready })]);

    await useDomain("example.com");

    expect(makePrimary).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(report()).toMatchObject({ domain: "example.com", primary: false, readiness: ready });
    expect(report().nextAction).toContain("run `clerk deploy use-domain example.com --yes`");
    expect(report().nextAction).toContain(
      "Session tokens from apps on example.com use the issuer https://clerk.example.com. " +
        "If your backend checks the issuer, accept it as well as https://clerk.acme.clerk.app before you switch, " +
        "because app versions you already shipped keep sending the old one.",
    );
    expect(report().nextAction).toContain(
      "If you use your own OAuth credentials, each provider's app needs both redirect URLs: " +
        "https://clerk.acme.clerk.app/v1/oauth_callback and https://clerk.example.com/v1/oauth_callback. " +
        "Add the new one before you switch.",
    );
    expect(process.exitCode).toBe(EXIT_CODE.GENERAL);
  });

  test("makes a ready domain primary", async () => {
    listReturns([managed, domain("example.com", { make_primary_readiness: ready })]);
    makePrimary.mockResolvedValue(domain("example.com", { make_primary_readiness: ready }));

    await useDomain("example.com", { yes: true });

    expect(makePrimary).toHaveBeenCalledWith("app_1", "dmn_example.com");
    expect(confirm).not.toHaveBeenCalled();
    expect(report()).toMatchObject({ primary: true });
    expect(report().nextAction).toContain("clerk env pull --instance prod");
    expect(report().nextAction).toContain(
      "acme.clerk.app keeps working for builds that still use it. Once none do, you can shut it down in the Clerk Dashboard: https://",
    );
    expect(report().nextAction).not.toContain("remove-domain");
    expect(process.exitCode).toBe(0);
  });

  // `clerk deploy` has a `--yes` of its own, which Commander parses there.
  test("--yes on the command line reaches the switch", async () => {
    listReturns([managed, domain("example.com", { make_primary_readiness: ready })]);
    makePrimary.mockResolvedValue(domain("example.com", { make_primary_readiness: ready }));

    await createProgram().parseAsync(["deploy", "use-domain", "example.com", "--yes"], {
      from: "user",
    });

    expect(makePrimary).toHaveBeenCalledWith("app_1", "dmn_example.com");
  });

  test("says hosting domains outlive the clerk.app shutdown and names the proxy target", async () => {
    listReturns([
      managed,
      domain("acme.netlify.app", { is_web_host: true }),
      domain("example.com", { make_primary_readiness: ready }),
    ]);
    makePrimary.mockResolvedValue(domain("example.com", { make_primary_readiness: ready }));

    await useDomain("example.com", { yes: true });

    expect(report().nextAction).toContain(
      "Your hosting domains keep working after the shutdown. Before it, redeploy the apps on them with the new keys, " +
        "and point any proxy you wrote yourself at https://frontend-api.clerk.dev instead of https://clerk.acme.clerk.app.",
    );
    expect(report().nextAction).not.toContain("remove-domain");
  });

  test("a person who passes --yes isn't asked", async () => {
    setMode("human");
    listReturns([managed, domain("example.com", { make_primary_readiness: ready })]);
    makePrimary.mockResolvedValue(domain("example.com", { make_primary_readiness: ready }));

    await useDomain("example.com", { yes: true });

    expect(confirm).not.toHaveBeenCalled();
    expect(makePrimary).toHaveBeenCalledWith("app_1", "dmn_example.com");
  });

  test("asks a person before switching, and stops when they decline", async () => {
    setMode("human");
    listReturns([managed, domain("example.com", { make_primary_readiness: ready })]);
    confirm.mockResolvedValue(false);

    await expect(useDomain("example.com")).rejects.toBeInstanceOf(UserAbortError);

    expect(makePrimary).not.toHaveBeenCalled();
    expect(captured.err).toContain(
      "Session tokens from apps on example.com use the issuer https://clerk.example.com. " +
        "If your backend checks the issuer, accept it as well as https://clerk.acme.clerk.app before you switch, " +
        "because app versions you already shipped keep sending the old one.",
    );
    expect(captured.err).toContain(
      "If you use your own OAuth credentials, each provider's app needs both redirect URLs: " +
        "https://clerk.acme.clerk.app/v1/oauth_callback and https://clerk.example.com/v1/oauth_callback. " +
        "Add the new one before you switch.",
    );
  });

  test("does nothing when the domain is already primary", async () => {
    listReturns([
      { ...managed, is_primary: false },
      domain("example.com", { is_primary: true, make_primary_readiness: ready }),
    ]);

    await useDomain("example.com");

    expect(create).not.toHaveBeenCalled();
    expect(makePrimary).not.toHaveBeenCalled();
    expect(report().nextAction).toContain("example.com is already the primary domain");
  });

  test("switches back to the clerk.app domain", async () => {
    listReturns([
      { ...managed, is_primary: false },
      domain("example.com", { is_primary: true, make_primary_readiness: ready }),
    ]);
    makePrimary.mockResolvedValue(managed);

    await useDomain("acme.clerk.app", { yes: true });

    expect(makePrimary).toHaveBeenCalledWith("app_1", "dmn_acme.clerk.app");
    expect(report().nextAction).not.toContain("shut it down");
  });

  test("refuses a satellite before adding or changing anything", async () => {
    listReturns([managed, domain("example.com", { is_satellite: true })]);

    const error = await useDomain("example.com").catch((e: unknown) => e);

    expect((error as CliError).code).toBe(ERROR_CODE.DEPLOY_DOMAIN_CONFLICT);
    expect(create).not.toHaveBeenCalled();
    expect(makePrimary).not.toHaveBeenCalled();
  });

  test("maps PLAPI's refusal of the switch when production left clerk.app after the list", async () => {
    listReturns([managed, domain("example.com", { make_primary_readiness: ready })]);
    makePrimary.mockRejectedValue(
      new PlapiError(
        403,
        JSON.stringify({ errors: [{ code: "primary_switch_not_allowed" }] }),
        "x",
      ),
    );

    const error = await useDomain("example.com", { yes: true }).catch((e: unknown) => e);

    expect((error as CliError).code).toBe(ERROR_CODE.PRIMARY_NOT_CLERK_MANAGED);
    expect((error as CliError).message).toContain("Nothing changed.");
  });

  test("maps a not-ready refusal from make_primary", async () => {
    listReturns([managed, domain("example.com", { make_primary_readiness: ready })]);
    makePrimary.mockRejectedValue(
      new PlapiError(
        422,
        JSON.stringify({
          errors: [{ code: "domain_not_ready_for_primary", meta: { missing: ["ssl"] } }],
        }),
        "x",
      ),
    );

    const error = await useDomain("example.com", { yes: true }).catch((e: unknown) => e);

    expect((error as CliError).code).toBe(ERROR_CODE.DOMAIN_NOT_READY);
    expect((error as CliError).message).toContain("SSL");
  });

  test("refuses a clerk.app name that isn't this application's", async () => {
    listReturns([managed]);

    await expect(useDomain("other.clerk.app")).rejects.toBeInstanceOf(CliError);
    expect(create).not.toHaveBeenCalled();
  });

  test.each([
    ["production on a domain you own", domain("own.com", { is_primary: true })],
    [
      "production on a provider domain",
      domain("acme.replit.app", { is_primary: true, is_provider_domain: true }),
    ],
  ] as [string, Domain][])("refuses before adding anything with %s", async (_label, primary) => {
    listReturns([primary]);

    const error = await useDomain("example.com", { yes: true }).catch((e: unknown) => e);

    expect((error as CliError).code).toBe(ERROR_CODE.PRIMARY_NOT_CLERK_MANAGED);
    expect((error as CliError).message).toContain(
      `production uses ${primary.name}. Nothing changed.`,
    );
    expect(create).not.toHaveBeenCalled();
    expect(makePrimary).not.toHaveBeenCalled();
  });

  test.each(["https://example.com", "-bad-.clerk.app", "acme.onrender.com"])(
    "rejects %s before any request",
    async (raw) => {
      const error = await useDomain(raw).catch((e: unknown) => e);

      expect((error as CliError).exitCode).toBe(EXIT_CODE.USAGE);
      expect(list).not.toHaveBeenCalled();
    },
  );
});
