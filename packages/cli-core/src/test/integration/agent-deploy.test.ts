/**
 * Agent-mode `clerk deploy --domain`
 * An AI agent creates or resumes the production instance without prompts.
 * Each test drives the command through the real parser against a mocked
 * Platform API and checks what the agent gets back: the exit code, the JSON
 * report or error, what was requested, and the production id in the profile.
 */

import { describe, test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  useIntegrationTestHarness,
  http,
  mockState,
  publishableKeyFor,
  setProfile,
  readConfig,
  clerk,
  MOCK_APP,
  MOCK_APP_DEV_ONLY,
  type CLIResult,
} from "./lib/harness.ts";
import type { Example } from "../../lib/help.ts";
import { useCleanClerkKeyEnv, useSyntheticShellClerkKeys } from "../lib/clerk-key-env.ts";

const h = useIntegrationTestHarness();
// The test process isn't a clerk install, so commands would start with bun
// and the test runner. The prefix rule has its own tests.
const { _setCliPrefix } = await import("../../lib/cli-invocation.ts");
_setCliPrefix("clerk");

const APP = "/v1/platform/applications/app_1";
const PROFILE_KEY = "github.com/test/project";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function apiError(
  status: number,
  code: string,
  message: string,
  meta: Record<string, unknown> = {},
): Response {
  return json({ errors: [{ code, message, long_message: message, meta }] }, status);
}

function productionDomain(name: string) {
  return {
    object: "domain",
    id: "dmn_1",
    name,
    is_satellite: false,
    is_provider_domain: false,
    frontend_api_url: `https://clerk.${name}`,
    development_origin: "",
    cname_targets: [
      { host: `clerk.${name}`, value: "frontend-api.clerk.services", required: true },
    ],
    created_at: "",
    updated_at: "",
  };
}

function createdInstance(domain: string | null) {
  return {
    object: "instance",
    id: "ins_prod",
    environment_type: "production",
    active_domain: domain ? productionDomain(domain) : null,
    publishable_key: "pk_live_xyz789",
    created_at: 0,
    updated_at: 0,
  };
}

const domainIncomplete = {
  status: "incomplete",
  dns: { status: "not_started", required: true },
  ssl: { status: "not_started", required: true },
  mail: { status: "not_started", required: true },
};

/** What the mocked Platform API holds. The handlers may change it. */
type PlatformApi = {
  /** The application has a production instance. */
  production: boolean;
  /** The production domain Clerk lists, or null while it is still provisioning. */
  domain: string | null;
  /** Answers the create request. By default it creates production on the requested domain. */
  create: (api: PlatformApi, domain: string) => Response;
  /** Answers application reads after the first, when set. */
  laterApplicationRead?: () => Response;
  domainStatus: () => Response;
  /** Answers `clerk deploy status`'s DNS check. */
  dnsCheck: () => Response;
  /** Production's config. By default Google is enabled with no credentials. */
  productionConfig: Record<string, unknown>;
};

function stubPlatformApi(overrides: Partial<PlatformApi> = {}): PlatformApi {
  const api: PlatformApi = {
    production: false,
    domain: null,
    create: (state, domain) => {
      state.production = true;
      state.domain = domain;
      return json(createdInstance(domain));
    },
    domainStatus: () => json(domainIncomplete),
    dnsCheck: () => json({ ...domainIncomplete, domain_id: "dmn_1", last_run_at: null }),
    productionConfig: { connection_oauth_google: { enabled: true } },
    ...overrides,
  };
  let applicationReads = 0;
  http.stub(async (url, init) => {
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname;
    if (method === "POST" && path === `${APP}/instances`) {
      const body = JSON.parse(String(init?.body)) as { domain: string };
      return api.create(api, body.domain);
    }
    if (method === "GET" && path === APP) {
      applicationReads += 1;
      if (applicationReads > 1 && api.laterApplicationRead) return api.laterApplicationRead();
      return json(api.production ? MOCK_APP : MOCK_APP_DEV_ONLY);
    }
    if (method === "GET" && path === `${APP}/domains`) {
      const data = api.domain ? [productionDomain(api.domain)] : [];
      return json({ data, total_count: data.length });
    }
    if (method === "GET" && path === `${APP}/domains/dmn_1/status`) return api.domainStatus();
    if (method === "POST" && path === `${APP}/domains/dmn_1/dns_check`) return api.dnsCheck();
    if (method === "GET" && path === `${APP}/instances/ins_dev/config/schema`) {
      return json({
        properties: {
          connection_oauth_google: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              client_id: { type: "string" },
              client_secret: { type: "string", "x-clerk-sensitive": true },
            },
          },
        },
      });
    }
    if (method === "GET" && path === `${APP}/instances/ins_prod/config`) {
      return json(api.productionConfig);
    }
    // Like the Platform API: each top-level key in the body is merged in.
    if (method === "PATCH" && path === `${APP}/instances/ins_prod/config`) {
      const body = JSON.parse(String(init?.body)) as Record<string, Record<string, unknown>>;
      const merged: Record<string, unknown> = { ...api.productionConfig };
      for (const [key, value] of Object.entries(body)) {
        merged[key] = { ...(merged[key] as Record<string, unknown> | undefined), ...value };
      }
      api.productionConfig = merged;
      return json(api.productionConfig);
    }
    if (method === "GET" && path === `${APP}/instances/ins_dev/config`) {
      return json({ connection_oauth_google: { enabled: true } });
    }
    throw new Error(`unmocked ${method} ${url}`);
  });
  return api;
}

async function linkDevelopmentOnly(): Promise<void> {
  await setProfile(PROFILE_KEY, {
    workspaceId: "",
    appId: "app_1",
    instances: { development: "ins_dev" },
  });
}

async function savedProductionInstance(): Promise<string | undefined> {
  return (await readConfig()).profiles[PROFILE_KEY]?.instances.production;
}

function createRequests() {
  return http.requests.filter((request) => request.method === "POST");
}

/** Agent mode prints a failure as one JSON object on stderr. */
function agentError(result: CLIResult): {
  code: string;
  message: string;
  docsUrl?: string;
  examples?: Example[];
} {
  return (JSON.parse(result.stderr) as { error: { code: string; message: string } }).error;
}

async function deploy(...args: string[]): Promise<CLIResult> {
  return clerk.raw("--mode", "agent", "deploy", ...args);
}

// The lead sentence and `not_linked` must not change; the advice depends
// on what the folder holds and which credential is present. Each case names
// its credential: a stored session only, the API key only, or none.
describe("without a linked project", () => {
  useSyntheticShellClerkKeys();
  useCleanClerkKeyEnv();

  const LEAD = "No Clerk project linked to this directory.";
  const KEY = publishableKeyFor("folder-app.clerk.accounts.dev");
  const write = (file: string, content: string) => Bun.write(join(h.tempDir, file), content);
  const FOLDERS = {
    initApp: async () => {
      // The token file needs both fields, or the CLI ignores it.
      await write(
        ".clerk/keyless.json",
        JSON.stringify({ claimToken: "claim_token_init", createdAt: new Date().toISOString() }),
      );
      await write(".env", `CLERK_PUBLISHABLE_KEY=${KEY}\n`);
    },
    sdkApp: () =>
      write(
        ".clerk/.tmp/keyless.json",
        JSON.stringify({
          publishableKey: KEY,
          secretKey: "sk_test_sdk",
          claimUrl: "https://dashboard.clerk.com/apps/claim?token=sdk_claim_token",
        }),
      ),
    publishableKey: () => write(".env", `CLERK_PUBLISHABLE_KEY=${KEY}\n`),
    secretKeyOnly: () => write(".env", "CLERK_SECRET_KEY=sk_test_folder\n"),
    // No framework, so no documented order between the two files.
    couldntTell: async () => {
      await write(".env", `CLERK_PUBLISHABLE_KEY=${KEY}\n`);
      await write(
        ".env.local",
        `CLERK_PUBLISHABLE_KEY=${publishableKeyFor("other.clerk.accounts.dev")}\n`,
      );
    },
    none: async () => {},
  };
  type Credential = "session" | "api_key" | "none";
  const LIST_AND_LINK = ["clerk apps list --json", "clerk link --app <app_id>"];
  // The commands before the rerun, for each kind and credential.
  const KINDS: {
    kind: string;
    credential: Credential;
    setUp: () => Promise<unknown>;
    expected: string[];
    says?: string;
  }[] = [
    {
      kind: "an init app",
      credential: "session",
      setUp: FOLDERS.initApp,
      expected: ["clerk link"],
      says: "created by `clerk init`",
    },
    {
      kind: "an init app",
      credential: "api_key",
      setUp: FOLDERS.initApp,
      expected: ["clerk link"],
      says: "created by `clerk init`",
    },
    {
      kind: "an init app",
      credential: "none",
      setUp: FOLDERS.initApp,
      expected: ["clerk auth login"],
      says: "created by `clerk init`",
    },
    {
      kind: "an SDK app",
      credential: "session",
      setUp: FOLDERS.sdkApp,
      expected: ["clerk open", "clerk link"],
    },
    {
      kind: "an SDK app",
      credential: "none",
      setUp: FOLDERS.sdkApp,
      expected: ["clerk open", "clerk auth login", "clerk link"],
    },
    {
      kind: "a publishable key",
      credential: "session",
      setUp: FOLDERS.publishableKey,
      expected: ["clerk link"],
      says: "publishable key is `CLERK_PUBLISHABLE_KEY` in .env",
    },
    {
      kind: "a publishable key",
      credential: "none",
      setUp: FOLDERS.publishableKey,
      expected: ["clerk auth login", "clerk link"],
      says: "publishable key is `CLERK_PUBLISHABLE_KEY` in .env",
    },
    {
      kind: "a secret key only",
      credential: "session",
      setUp: FOLDERS.secretKeyOnly,
      expected: LIST_AND_LINK,
    },
    {
      kind: "keys the CLI couldn't tell apart",
      credential: "session",
      setUp: FOLDERS.couldntTell,
      expected: LIST_AND_LINK,
    },
    {
      kind: "no keys",
      credential: "session",
      setUp: FOLDERS.none,
      expected: [...LIST_AND_LINK, "clerk init"],
    },
    {
      kind: "no keys",
      credential: "none",
      setUp: FOLDERS.none,
      expected: ["clerk auth login", ...LIST_AND_LINK, "clerk init"],
    },
  ];
  // The rerun keeps the flags: an agent creates production only with --domain.
  const CELLS = KINDS.flatMap((kind) => [
    { ...kind, args: [], rerun: "clerk deploy" },
    { ...kind, args: ["--domain", "example.com"], rerun: "clerk deploy --domain example.com" },
    { ...kind, args: ["status"], rerun: "clerk deploy status" },
  ]);

  async function useCredential(credential: Credential): Promise<void> {
    if (credential !== "api_key") delete process.env.CLERK_PLATFORM_API_KEY;
    if (credential !== "session") mockState.storedToken = null;
  }

  test.each(CELLS)(
    "$kind, $credential, deploy $args: not_linked, exit 1, creates nothing, $expected then $rerun",
    async ({ setUp, credential, args, expected, says, rerun }) => {
      await setUp();
      await useCredential(credential);
      stubPlatformApi();

      const result = await deploy(...args);
      const error = agentError(result);

      expect(result.exitCode).toBe(1);
      expect(error.code).toBe("not_linked");
      expect(error.message.startsWith(`${LEAD} `)).toBe(true);
      expect((error.examples ?? []).map((example) => example.command)).toEqual([
        ...expected,
        rerun,
      ]);
      if (says) expect(error.message).toContain(says);
      expect(error.message).not.toContain("deploy --app");
      expect(result.stdout).toBe("");
      // Classifying the folder makes no API call.
      expect(http.requests).toEqual([]);
    },
  );

  test("a person gets the step in the message and no Examples block", async () => {
    stubPlatformApi();

    const result = await clerk.raw("deploy", "--domain", "example.com");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(LEAD);
    expect(result.stderr).toContain("Run `clerk link` to choose one of your apps");
    expect(result.stderr).toContain("Then run `clerk deploy --domain example.com` again.");
    expect(result.stderr).not.toContain("Examples:");
  });
});

describe("creating or resuming production", () => {
  test("creates production on the requested domain and reports what is left", async () => {
    await linkDevelopmentOnly();
    stubPlatformApi();

    const result = await deploy("--domain", "Example.COM");

    expect(result.exitCode).toBe(0);
    expect(createRequests().map((request) => JSON.parse(request.body ?? ""))).toEqual([
      { domain: "example.com", environment_type: "production", clone_instance_id: "ins_dev" },
    ]);
    const report = JSON.parse(result.stdout);
    expect(report.state).toBe("domain_pending");
    expect(report.domain).toBe("example.com");
    expect(report.productionInstanceId).toBe("ins_prod");
    expect(report.pendingDnsRecords).toEqual([
      {
        type: "CNAME",
        host: "clerk.example.com",
        value: "frontend-api.clerk.services",
        required: true,
      },
    ]);
    expect(report.oauth.setup.map((entry: { provider: string }) => entry.provider)).toEqual([
      "google",
    ]);
    expect(report.oauth.setup[0].command).toBe(
      "clerk config patch --instance ins_prod --file <file> --yes",
    );
    // `--instance prod` has to resolve for the commands the report names next.
    expect(await savedProductionInstance()).toBe("ins_prod");
  });

  test("resumes an existing production instance on the same domain without creating", async () => {
    await linkDevelopmentOnly();
    stubPlatformApi({ production: true, domain: "example.com" });

    const result = await deploy("--domain", "example.com");

    expect(result.exitCode).toBe(0);
    expect(createRequests()).toEqual([]);
    expect(JSON.parse(result.stdout).state).toBe("domain_pending");
    expect(await savedProductionInstance()).toBe("ins_prod");
  });

  test("refuses a domain other than the existing instance's", async () => {
    await linkDevelopmentOnly();
    stubPlatformApi({ production: true, domain: "example.com" });

    const result = await deploy("--domain", "other.com");

    expect(result.exitCode).toBe(1);
    expect(agentError(result).code).toBe("production_instance_exists");
    expect(agentError(result).message).toContain(
      "already has a production instance on example.com, so --domain other.com was not applied",
    );
    expect(result.stdout).toBe("");
    expect(createRequests()).toEqual([]);
  });

  test("resumes the instance another run created first", async () => {
    await linkDevelopmentOnly();
    stubPlatformApi({
      create: (api) => {
        api.production = true;
        api.domain = "example.com";
        return apiError(409, "production_instance_exists", "exists");
      },
    });

    const result = await deploy("--domain", "example.com");

    expect(result.exitCode).toBe(0);
    expect(createRequests()).toHaveLength(1);
    expect(JSON.parse(result.stdout).productionInstanceId).toBe("ins_prod");
    expect(await savedProductionInstance()).toBe("ins_prod");
  });

  test("fails as unresolved when Clerk says production exists but does not return it", async () => {
    await linkDevelopmentOnly();
    stubPlatformApi({ create: () => apiError(409, "production_instance_exists", "exists") });

    const result = await deploy("--domain", "example.com");

    expect(result.exitCode).toBe(1);
    expect(agentError(result).code).toBe("deploy_instance_unresolved");
    expect(result.stdout).toBe("");
  });
});

// The commands the report hands the agent, run one after another as given:
// create, save Google with the entry's own command, verify, print the keys.
describe("the whole handoff", () => {
  test("goes from create to complete and prints exactly the two keys", async () => {
    await linkDevelopmentOnly();
    stubPlatformApi({
      domainStatus: () =>
        json({
          status: "complete",
          dns: { status: "complete", required: true },
          ssl: { status: "complete", required: true },
          mail: { status: "complete", required: true },
        }),
    });

    const created = await deploy("--domain", "example.com");
    expect(created.exitCode).toBe(0);
    const report = JSON.parse(created.stdout);
    expect(report.state).toBe("oauth_pending");
    const entry = report.oauth.setup.find(
      (candidate: { provider: string }) => candidate.provider === "google",
    );

    // What the agent and user do: the payload in a file outside the project,
    // the placeholders replaced with the real (here fake) values.
    const dir = await mkdtemp(join(tmpdir(), "clerk-oauth-"));
    const file = join(dir, "google.json");
    await Bun.write(
      file,
      JSON.stringify(entry.payload)
        .replace("<client_id>", "pr536-fake.apps.googleusercontent.com")
        .replace("<client_secret>", "pr536-fake-oauth-secret"),
    );
    const [binary, ...args] = (entry.command as string).split(" ");
    expect(binary).toBe("clerk");
    let saved: CLIResult;
    try {
      saved = await clerk.raw(
        "--mode",
        "agent",
        ...args.map((arg) => (arg === "<file>" ? file : arg)),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(saved.exitCode).toBe(0);

    const exitCodeBefore = process.exitCode;
    let status: CLIResult;
    try {
      status = await clerk.raw("--mode", "agent", "deploy", "status");
    } finally {
      process.exitCode = exitCodeBefore;
    }
    expect(JSON.parse(status.stdout).state).toBe("complete");

    const pulled = await clerk.raw(
      "--mode",
      "agent",
      "env",
      "pull",
      "--instance",
      "ins_prod",
      "--print",
    );
    expect(pulled.exitCode).toBe(0);
    const lines = pulled.stdout.trim().split("\n");
    expect(lines.map((line) => line.split("=")[0])).toEqual([
      "CLERK_PUBLISHABLE_KEY",
      "CLERK_SECRET_KEY",
    ]);
    expect(lines).toContain(`CLERK_SECRET_KEY=${MOCK_APP.instances[1]!.secret_key}`);
    expect(
      await Promise.all(
        [".env", ".env.local", ".env.production"].map((name) =>
          Bun.file(join(h.tempDir, name)).exists(),
        ),
      ),
    ).toEqual([false, false, false]);
    // Only `--print`'s stdout carries a key, by design.
    const everythingElse = [
      created.stdout,
      created.stderr,
      saved.stdout,
      saved.stderr,
      status.stdout,
      status.stderr,
      pulled.stderr,
    ].join("\n");
    expect(everythingElse).not.toMatch(/sk_(live|test)_|pr536-fake-oauth-secret/);
  });
});

describe("a deploy that is complete on Clerk's side", () => {
  // The report is read by the agent, so neither Clerk key (MOCK_APP carries
  // both instances' secret keys) nor a saved OAuth secret may appear in it.
  test("prints no secret and names the production instance for the key copy", async () => {
    await linkDevelopmentOnly();
    stubPlatformApi({
      production: true,
      domain: "example.com",
      domainStatus: () =>
        json({
          status: "complete",
          dns: { status: "complete", required: true },
          ssl: { status: "complete", required: true },
          mail: { status: "complete", required: true },
        }),
      productionConfig: {
        connection_oauth_google: {
          enabled: true,
          client_id: "client.apps.googleusercontent.com",
          client_secret: "FAKE_GOOGLE_CLIENT_SECRET",
        },
      },
    });

    const result = await deploy("--domain", "example.com");

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.state).toBe("complete");
    expect(report.nextAction).toContain("clerk env pull --instance ins_prod --print");
    // The command the agent runs is its own field, naming the instance by id;
    // it pipes the keys, so it carries none itself.
    expect(report.hostSetup).toHaveLength(1);
    expect(report.hostSetup[0].host).toBe("vercel");
    expect(report.hostSetup[0].command).toContain(
      "keys=$(clerk env pull --instance ins_prod --print) || exit 1;",
    );
    expect(report.hostSetup[0].command).not.toMatch(/sk_(live|test)_|pk_(live|test)_/);
    const output = result.stdout + result.stderr;
    expect(output).not.toContain("sk_live_");
    expect(output).not.toContain("sk_test_");
    expect(output).not.toContain("FAKE_GOOGLE_CLIENT_SECRET");
  });
});

describe("while the production domain is still provisioning", () => {
  const unchecked =
    "This application already has a production instance, but Clerk hasn't returned its domain yet, " +
    "so --domain other.com could not be checked against it. " +
    "This run did not change the instance's domain. Nothing was changed in Clerk. " +
    "Run `clerk deploy status` to see its domain once Clerk returns it.";

  test("refuses --domain on an instance this run found", async () => {
    await linkDevelopmentOnly();
    stubPlatformApi({ production: true, domain: null });

    const result = await deploy("--domain", "other.com");

    expect(result.exitCode).toBe(1);
    expect(agentError(result).code).toBe("deploy_domain_unchecked");
    expect(agentError(result).message).toBe(unchecked);
    expect(result.stdout).toBe("");
    expect(createRequests()).toEqual([]);
  });

  test("refuses --domain on an instance another run created first", async () => {
    await linkDevelopmentOnly();
    stubPlatformApi({
      create: (api) => {
        api.production = true;
        return apiError(409, "production_instance_exists", "exists");
      },
    });

    const result = await deploy("--domain", "other.com");

    expect(result.exitCode).toBe(1);
    expect(agentError(result).code).toBe("deploy_domain_unchecked");
    expect(agentError(result).message).toBe(unchecked);
  });

  test("reports provisioning when this run created the instance", async () => {
    await linkDevelopmentOnly();
    stubPlatformApi({
      create: (api) => {
        api.production = true;
        return json(createdInstance(null));
      },
    });

    const result = await deploy("--domain", "other.com");

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.state).toBe("domain_provisioning");
    expect(report.productionInstanceId).toBe("ins_prod");
    expect(await savedProductionInstance()).toBe("ins_prod");
  });
});

describe("when the read after the instance exists fails", () => {
  test("a server error says the instance exists and to run deploy status", async () => {
    await linkDevelopmentOnly();
    stubPlatformApi({ laterApplicationRead: () => apiError(500, "internal_clerk_error", "boom") });

    const result = await deploy("--domain", "example.com");

    expect(result.exitCode).toBe(1);
    // Clerk's own code, not one of the CLI's: only a 404 on the domain's
    // status is translated.
    expect(agentError(result).code).toBe("internal_clerk_error");
    expect(agentError(result).message).toStartWith(
      "The production instance exists, but its status could not be read; run `clerk deploy status` to retry",
    );
    expect(result.stdout).toBe("");
    expect(await savedProductionInstance()).toBe("ins_prod");
  });

  // A 404 on the domain's status means it isn't readable yet; the application
  // was read moments earlier.
  test.each([
    { run: "created", production: false, domain: null, verb: "was created" },
    { run: "found", production: true, domain: "example.com", verb: "exists" },
  ])(
    "a 404 on an instance this run $run says it $verb, not to re-link",
    async ({ production, domain, verb }) => {
      await linkDevelopmentOnly();
      stubPlatformApi({
        production,
        domain,
        domainStatus: () => apiError(404, "resource_not_found", "not found"),
      });

      const result = await deploy("--domain", "example.com");

      expect(result.exitCode).toBe(1);
      expect(agentError(result)).toEqual({
        code: "deploy_instance_unresolved",
        message:
          `The production instance ${verb}, but its status couldn't be read yet. ` +
          "Run `clerk deploy status` to check it." +
          (verb === "exists"
            ? " If the production instance was deleted, `clerk deploy status` reports `not_started` once Clerk stops listing it; then run `clerk deploy --domain`."
            : ""),
      });
      expect(result.stdout).toBe("");
      expect(await savedProductionInstance()).toBe("ins_prod");
    },
  );
});

describe("clerk deploy status", () => {
  test("a 404 on the DNS check says the instance exists, not to re-link", async () => {
    await linkDevelopmentOnly();
    stubPlatformApi({
      production: true,
      domain: "example.com",
      dnsCheck: () => apiError(404, "resource_not_found", "not found"),
    });

    const result = await clerk.raw("--mode", "agent", "deploy", "status");

    expect(result.exitCode).toBe(1);
    expect(agentError(result)).toEqual({
      code: "deploy_instance_unresolved",
      message:
        "The production instance exists, but Clerk couldn't read its domain status yet. " +
        "Run `clerk deploy status` again shortly. " +
        "If the production instance was deleted, `clerk deploy status` reports `not_started` once Clerk stops listing it; then run `clerk deploy --domain`.",
    });
    expect(result.stdout).toBe("");
  });
});

describe("when the create is refused", () => {
  test("a 403 passes Clerk's error through and saves nothing", async () => {
    await linkDevelopmentOnly();
    stubPlatformApi({
      create: () =>
        apiError(403, "authorization_invalid", "You are not authorized to perform this request"),
    });

    const result = await deploy("--domain", "example.com");

    expect(result.exitCode).toBe(1);
    expect(agentError(result).code).toBe("authorization_invalid");
    expect(agentError(result).message).toContain("You are not authorized to perform this request");
    expect(result.stdout).toBe("");
    expect(await savedProductionInstance()).toBeUndefined();
  });

  test("a 422 names the invalid parameter", async () => {
    await linkDevelopmentOnly();
    stubPlatformApi({
      create: () =>
        apiError(422, "form_param_format_invalid", "domain is invalid", { param_name: "domain" }),
    });

    const result = await deploy("--domain", "example.com");

    expect(result.exitCode).toBe(1);
    expect(agentError(result).code).toBe("form_param_invalid");
    expect(agentError(result).message).toContain("(parameter: domain)");
    expect(result.stdout).toBe("");
    expect(await savedProductionInstance()).toBeUndefined();
  });

  test("a plan that does not cover development's features lists them and links pricing", async () => {
    await linkDevelopmentOnly();
    stubPlatformApi({
      create: () =>
        apiError(402, "unsupported_subscription_plan_features", "plan", {
          unsupported_features: ["saml"],
        }),
    });

    const result = await deploy("--domain", "example.com");

    expect(result.exitCode).toBe(1);
    const error = agentError(result);
    expect(error.code).toBe("plan_insufficient");
    expect(error.message).toContain("• saml");
    expect(error.docsUrl).toBe("https://clerk.com/pricing");
    expect(result.stdout).toBe("");
    expect(await savedProductionInstance()).toBeUndefined();
  });
});
