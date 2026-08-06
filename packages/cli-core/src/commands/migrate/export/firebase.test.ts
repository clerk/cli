import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getMode, setMode } from "../../../mode.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "../../../lib/errors.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { getLogDir } from "../lib/logger.ts";
import {
  buildFirebaseExport,
  exportFirebase,
  fetchAccessToken,
  fetchAllFirebaseUsers,
  fetchHashConfig,
  formatHashConfigGuidance,
  mapFirebaseUserToExport,
  readServiceAccount,
  signServiceAccountJwt,
  type ServiceAccount,
} from "./firebase.ts";

const captured = useCaptureLog();

let workDir: string;
let originalCwd: string;
let originalFetch: typeof globalThis.fetch;
let requests: { url: string; body: unknown }[];
let account: ServiceAccount;

beforeAll(async () => {
  originalCwd = process.cwd();
  originalFetch = globalThis.fetch;
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-fb-")));
  process.chdir(workDir);

  // A real RSA key, so the signing path is genuinely exercised.
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const body = btoa(String.fromCharCode(...new Uint8Array(pkcs8))).replace(/(.{64})/g, "$1\n");

  account = {
    project_id: "demo-fb",
    client_email: "exp@demo-fb.iam.gserviceaccount.com",
    private_key: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
  };
  fs.writeFileSync(
    path.join(workDir, "sa.json"),
    JSON.stringify({ type: "service_account", ...account }),
  );
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  fs.rmSync(getLogDir(), { recursive: true, force: true });
  fs.rmSync(path.join(workDir, "exports"), { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
});

/** Answers the token exchange, then one page per entry in `pages`. */
function stubFirebase(pages: Record<string, unknown>[][], hashConfig?: unknown) {
  let page = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    requests.push({ url, body: init?.body ?? null });

    if (url.includes("oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "tok" });
    }
    if (url.includes("/config")) {
      return hashConfig === undefined
        ? new Response("forbidden", { status: 403 })
        : Response.json(hashConfig);
    }
    const current = pages[page++] ?? [];
    const hasMore = page < pages.length;
    return Response.json({ users: current, ...(hasMore ? { nextPageToken: `p${page}` } : {}) });
  }) as unknown as typeof fetch;
}

const fbUser = (i: number, overrides: Record<string, unknown> = {}) => ({
  localId: `fb${i}`,
  email: `u${i}@fb.dev`,
  emailVerified: true,
  displayName: `User ${i}`,
  passwordHash: `SGFzaA${i}`,
  salt: `U2FsdA${i}`,
  createdAt: "1704067200000",
  ...overrides,
});

describe("readServiceAccount", () => {
  test("reads a valid key file", () => {
    expect(readServiceAccount("./sa.json").project_id).toBe("demo-fb");
  });

  test("reports a path that is not there", () => {
    expect(() => readServiceAccount("./nope.json")).toThrow(/No service account file at/);
  });

  test("reports a file that is not JSON", () => {
    fs.writeFileSync(path.join(workDir, "bad.json"), "not json");
    expect(() => readServiceAccount("./bad.json")).toThrow(/is not valid JSON/);
  });

  // Downloading the web app config instead of a service account key is the
  // usual mistake, and the two files look similar at a glance.
  test("points at the right console page for a web app config", () => {
    fs.writeFileSync(path.join(workDir, "web.json"), JSON.stringify({ apiKey: "x" }));
    expect(() => readServiceAccount("./web.json")).toThrow(/"project_id" is missing/);
  });

  test("names a wrong type explicitly", () => {
    fs.writeFileSync(path.join(workDir, "wrong.json"), JSON.stringify({ type: "authorized_user" }));
    expect(() => readServiceAccount("./wrong.json")).toThrow(
      /"type" is "authorized_user".*Generate new private key/s,
    );
  });

  test.each([["project_id"], ["client_email"], ["private_key"]])(
    "reports a missing %s",
    (field) => {
      const partial: Record<string, unknown> = { type: "service_account", ...account };
      delete partial[field];
      fs.writeFileSync(path.join(workDir, `no-${field}.json`), JSON.stringify(partial));
      expect(() => readServiceAccount(`./no-${field}.json`)).toThrow(
        new RegExp(`"${field}" is missing`),
      );
    },
  );

  // Pasting a key through a form that eats newlines is common, and the failure
  // would otherwise surface as an opaque crypto error.
  test("catches a private key whose newlines were mangled", () => {
    fs.writeFileSync(
      path.join(workDir, "mangled.json"),
      JSON.stringify({ type: "service_account", ...account, private_key: "mangled" }),
    );
    expect(() => readServiceAccount("./mangled.json")).toThrow(/newlines survived copying/);
  });

  test("raises CliError so the global handler formats it", () => {
    expect(() => readServiceAccount("./nope.json")).toThrow(CliError);
  });
});

describe("signServiceAccountJwt", () => {
  test("produces a three-segment RS256 JWT", async () => {
    const jwt = await signServiceAccountJwt(account);
    expect(jwt.split(".")).toHaveLength(3);
  });

  test("claims the right issuer, audience and scopes", async () => {
    const jwt = await signServiceAccountJwt(account, 1_700_000_000);
    const claims = JSON.parse(
      atob((jwt.split(".")[1] as string).replace(/-/g, "+").replace(/_/g, "/")),
    );

    expect(claims).toMatchObject({
      iss: "exp@demo-fb.iam.gserviceaccount.com",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    expect(claims.scope).toContain("cloud-platform");
  });

  test("declares RS256 in the header", async () => {
    const jwt = await signServiceAccountJwt(account);
    const header = JSON.parse(
      atob((jwt.split(".")[0] as string).replace(/-/g, "+").replace(/_/g, "/")),
    );
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
  });

  test("rejects a private key that is not valid base64", async () => {
    await expect(
      signServiceAccountJwt({
        ...account,
        private_key: "-----BEGIN PRIVATE KEY-----\n!!!\n-----END PRIVATE KEY-----",
      }),
    ).rejects.toThrow(CliError);
  });
});

describe("fetchAccessToken", () => {
  test("exchanges the assertion for a token", async () => {
    stubFirebase([[]]);

    expect(await fetchAccessToken(account)).toBe("tok");
    expect(String(requests[0]?.body)).toContain("grant-type%3Ajwt-bearer");
  });

  test("explains a rejection rather than surfacing a raw status", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error_description: "Invalid JWT Signature" }), {
        status: 400,
      })) as unknown as typeof fetch;

    await expect(fetchAccessToken(account)).rejects.toThrow(
      /Google rejected the service account \(400\): Invalid JWT Signature/,
    );
  });

  test("names the role the service account usually lacks", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    await expect(fetchAccessToken(account)).rejects.toThrow(/Firebase Authentication Admin/);
  });

  // The emulator has no token endpoint; `firebase-admin` uses the same bearer.
  test("skips the exchange entirely against the emulator", async () => {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
    globalThis.fetch = (async () => {
      throw new Error("should not have been called");
    }) as unknown as typeof fetch;

    expect(await fetchAccessToken(account)).toBe("owner");
  });
});

describe("fetchAllFirebaseUsers", () => {
  test("follows nextPageToken until it stops coming", async () => {
    stubFirebase([
      Array.from({ length: 1000 }, (_, i) => fbUser(i)),
      Array.from({ length: 7 }, (_, i) => fbUser(1000 + i)),
    ]);

    const all = await fetchAllFirebaseUsers({ account, token: "tok" });

    expect(all).toHaveLength(1007);
    expect(requests[1]?.url).toContain("nextPageToken=p1");
  });

  test("asks for the endpoint's maximum page size", async () => {
    stubFirebase([[]]);
    await fetchAllFirebaseUsers({ account, token: "tok" });
    expect(requests[0]?.url).toContain("maxResults=1000");
  });

  test("targets the project named in the key", async () => {
    stubFirebase([[]]);
    await fetchAllFirebaseUsers({ account, token: "tok" });
    expect(requests[0]?.url).toContain("/projects/demo-fb/accounts:batchGet");
  });

  test("routes through the emulator when one is configured", async () => {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
    stubFirebase([[]]);

    await fetchAllFirebaseUsers({ account, token: "owner" });

    expect(requests[0]?.url).toStartWith("http://127.0.0.1:9099/");
  });

  test("raises a clear error on a failed page", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;

    await expect(fetchAllFirebaseUsers({ account, token: "tok" })).rejects.toThrow(
      /Firebase returned 500 listing users/,
    );
  });
});

describe("mapFirebaseUserToExport", () => {
  test("keeps the fields the firebase transformer maps from", () => {
    expect(mapFirebaseUserToExport(fbUser(0))).toEqual({
      localId: "fb0",
      email: "u0@fb.dev",
      displayName: "User 0",
      createdAt: "1704067200000",
      emailVerified: true,
      passwordHash: "SGFzaA0",
      salt: "U2FsdA0",
    });
  });

  test("drops project internals the import has no use for", () => {
    const mapped = mapFirebaseUserToExport(
      fbUser(0, {
        providerUserInfo: [{ providerId: "password" }],
        lastLoginAt: "1704153600000",
        customAttributes: '{"role":"x"}',
        validSince: "1704067200",
      }),
    );
    for (const noise of ["providerUserInfo", "lastLoginAt", "customAttributes", "validSince"]) {
      expect(noise in mapped).toBe(false);
    }
  });

  // A digest without its salt cannot be verified, so exporting one alone would
  // produce a user nobody can sign in as.
  test.each([
    ["hash without salt", { passwordHash: "H", salt: undefined }],
    ["salt without hash", { passwordHash: undefined, salt: "S" }],
  ])("drops a %s", (_label, overrides) => {
    const mapped = mapFirebaseUserToExport(fbUser(0, overrides));
    expect("passwordHash" in mapped).toBe(false);
    expect("salt" in mapped).toBe(false);
  });

  test("keeps emailVerified when it is false", () => {
    expect(mapFirebaseUserToExport(fbUser(0, { emailVerified: false })).emailVerified).toBe(false);
  });

  test("copes with a phone-only user", () => {
    const mapped = mapFirebaseUserToExport({ localId: "fb9", phoneNumber: "+15555550100" });
    expect(mapped).toEqual({ localId: "fb9", phoneNumber: "+15555550100" });
  });
});

describe("buildFirebaseExport", () => {
  test("counts coverage and logs each user", () => {
    const { users, coverage } = buildFirebaseExport(
      [fbUser(0), { localId: "fb1", phoneNumber: "+1555" }],
      "2026-01-01T12:00:00",
    );

    expect(users).toHaveLength(2);
    const byLabel = Object.fromEntries(coverage.map((c) => [c.label, c.count]));
    expect(byLabel["have a password hash"]).toBe(1);
    expect(byLabel["have a phone number"]).toBe(1);
    expect(fs.readdirSync(getLogDir())[0]).toBe("export-2026-01-01T12-00-00.log");
  });
});

describe("fetchHashConfig", () => {
  test("reads the project's scrypt parameters", async () => {
    stubFirebase([[]], {
      signIn: {
        hashConfig: { signerKey: "KEY==", saltSeparator: "Bw==", rounds: 8, memoryCost: 14 },
      },
    });

    expect(await fetchHashConfig(account, "tok")).toEqual({
      signerKey: "KEY==",
      saltSeparator: "Bw==",
      rounds: 8,
      memoryCost: 14,
    });
  });

  // Reading the config needs a broader role than listing users, so a project
  // where it is denied must still export.
  test("returns null rather than failing when the call is not permitted", async () => {
    stubFirebase([[]]);
    expect(await fetchHashConfig(account, "tok")).toBeNull();
  });

  test("returns null when the response carries no hash config", async () => {
    stubFirebase([[]], { signIn: {} });
    expect(await fetchHashConfig(account, "tok")).toBeNull();
  });
});

describe("formatHashConfigGuidance", () => {
  const config = { signerKey: "KEY==", saltSeparator: "Bw==", rounds: 8, memoryCost: 14 };

  test("prints the exact import command when the parameters are known", () => {
    const text = formatHashConfigGuidance(config, "exports/firebase-export.json", 3).join("\n");
    expect(text).toContain('--firebase-signer-key "KEY=="');
    expect(text).toContain('--firebase-salt-separator "Bw=="');
    expect(text).toContain("--firebase-rounds 8 --firebase-mem-cost 14");
  });

  test("says where to find them when the project would not say", () => {
    const text = formatHashConfigGuidance(null, "out.json", 3).join("\n");
    expect(text).toContain("Password hash parameters");
    expect(text).toContain("Authentication → Users");
  });

  // Nothing to configure, so nothing to tell them to configure.
  test("says nothing is needed when the export has no hashes", () => {
    expect(formatHashConfigGuidance(null, "out.json", 0).join("\n")).toContain(
      "no hash parameters are needed",
    );
  });
});

describe("exportFirebase", () => {
  test("exports end to end and reports coverage", async () => {
    stubFirebase([[fbUser(0), fbUser(1)]], {
      signIn: { hashConfig: { signerKey: "K", saltSeparator: "S", rounds: 8, memoryCost: 14 } },
    });

    await exportFirebase({ serviceAccount: "./sa.json" });

    const written = JSON.parse(
      fs.readFileSync(path.join(workDir, "exports", "firebase-export.json"), "utf-8"),
    ) as Record<string, unknown>[];
    expect(written).toHaveLength(2);
    expect(captured.err).toContain("Field coverage");
    expect(captured.err).toContain("demo-fb project");
  });

  test("names the command that consumes the file", async () => {
    stubFirebase([[fbUser(0)]], { signIn: {} });
    // The suggestion now rides the gutter's Next steps block, which only
    // renders in human mode.
    const originalMode = getMode();
    setMode("human");
    try {
      await exportFirebase({ serviceAccount: "./sa.json" });
    } finally {
      setMode(originalMode);
    }
    expect(captured.err).toContain(
      "migrate run --transformer firebase --file exports/firebase-export.json",
    );
  });

  test("--output controls the destination", async () => {
    stubFirebase([[fbUser(0)]], { signIn: {} });
    await exportFirebase({ serviceAccount: "./sa.json", output: "fb.json" });
    expect(fs.existsSync(path.join(workDir, "fb.json"))).toBe(true);
  });

  test("requires --service-account, before anything is read", async () => {
    await expect(exportFirebase({})).rejects.toThrow(/needs a service account key file/);
  });

  test("validates the key file before making any request", async () => {
    stubFirebase([[fbUser(0)]]);
    await expect(exportFirebase({ serviceAccount: "./nope.json" })).rejects.toThrow(CliError);
    expect(requests).toHaveLength(0);
  });

  test("never puts key material in the output", async () => {
    stubFirebase([[fbUser(0)]], { signIn: {} });
    await exportFirebase({ serviceAccount: "./sa.json" });
    expect(captured.err).not.toContain("BEGIN PRIVATE KEY");
    expect(captured.err).not.toContain(account.private_key.slice(40, 80));
  });

  test("skips the hash-parameter section when nothing has a password", async () => {
    stubFirebase([[{ localId: "fb9", phoneNumber: "+1555" }]], { signIn: {} });
    await exportFirebase({ serviceAccount: "./sa.json" });
    expect(captured.err).toContain("no hash parameters are needed");
  });
});
