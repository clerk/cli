import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "../../../lib/errors.ts";
import type { UserLine } from "../lib/run-store.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { setAssumeYes } from "../lib/assume-yes.ts";
import {
  buildFirebaseExport,
  exportFirebase,
  fetchAccessToken,
  fetchAllFirebaseUsers,
  fetchHashConfig,
  formatHashConfigGuidance,
  loadServiceAccount,
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

let originalMode: string | undefined;

beforeAll(async () => {
  originalMode = process.env.CLERK_MODE;
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
  if (originalMode === undefined) delete process.env.CLERK_MODE;
  else process.env.CLERK_MODE = originalMode;
  globalThis.fetch = originalFetch;
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Tests that need a prompt set human mode themselves; without this a
  // leaked "human" from an earlier test stops a later one on the destination prompt.
  process.env.CLERK_MODE = "agent";
  requests = [];
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  fs.rmSync(path.join(workDir, ".clerk"), { recursive: true, force: true });
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

describe("loadServiceAccount", () => {
  // The prompt takes either, so a key pasted out of a password manager never
  // has to be written to disk first.
  test("accepts the key JSON pasted whole", () => {
    expect(loadServiceAccount(`  ${JSON.stringify(account)}  `).project_id).toBe("demo-fb");
  });

  test("accepts a path to the key file", () => {
    expect(loadServiceAccount("./sa.json").project_id).toBe("demo-fb");
  });

  test("rejects a paste that is not valid JSON", () => {
    expect(() => loadServiceAccount('{"project_id":')).toThrow(/pasted key is not valid JSON/);
  });

  test("rejects a paste missing a required field", () => {
    expect(() => loadServiceAccount('{"type":"service_account"}')).toThrow(
      /The pasted key is not a usable service account key: "project_id" is missing/,
    );
  });
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
    await expect(fetchAccessToken(account)).rejects.toThrow(/revoked or deleted/);
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

test("mapFirebaseUserToExport keeps disabled only when it is true", () => {
  expect(mapFirebaseUserToExport(fbUser(0, { disabled: true })).disabled).toBe(true);
  expect("disabled" in mapFirebaseUserToExport(fbUser(0, { disabled: false }))).toBe(false);
});

describe("buildFirebaseExport", () => {
  test("counts coverage and records each user", () => {
    const lines: UserLine[] = [];
    const { users, coverage } = buildFirebaseExport(
      [fbUser(0), { localId: "fb1", phoneNumber: "+1555" }],
      (line) => lines.push(line),
    );

    expect(users).toHaveLength(2);
    const byLabel = Object.fromEntries(coverage.map((c) => [c.label, c.count]));
    expect(byLabel["have a password hash"]).toBe(1);
    expect(byLabel["have a phone number"]).toBe(1);
    expect(lines).toHaveLength(2);
  });

  // Firebase returns an empty passwordHash for users it did not hash itself.
  test("counts password users whose hash Firebase did not return", () => {
    const { users, unreadablePasswords } = buildFirebaseExport([
      fbUser(0, { providerUserInfo: [{ providerId: "password" }] }),
      fbUser(1, { passwordHash: "", providerUserInfo: [{ providerId: "password" }] }),
      fbUser(2, { passwordHash: "", providerUserInfo: [{ providerId: "google.com" }] }),
    ]);
    expect(unreadablePasswords).toBe(1);
    expect("passwordHash" in users[1]!).toBe(false);
  });

  // Firebase sends base64 "REDACTED" when the caller may not read hashes: a
  // digest that could never verify, which must not be exported as one.
  test("treats a redacted hash as none, and counts it", () => {
    const { users, redactedPasswords } = buildFirebaseExport([
      fbUser(0, { passwordHash: "UkVEQUNURUQ=", providerUserInfo: [{ providerId: "password" }] }),
    ]);
    expect(redactedPasswords).toBe(1);
    expect("passwordHash" in users[0]!).toBe(false);
    expect("salt" in users[0]!).toBe(false);
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
    // Names the permission, so the operator can grant it rather than guess.
    expect(captured.err).toContain("firebaseauth.configs.getHashConfig");
  });

  // Every digest carries these, so a set Clerk would refuse is not written.
  test("leaves out parameters Clerk would refuse, and says so", async () => {
    stubFirebase([[]], {
      signIn: {
        hashConfig: { signerKey: "KEY==", saltSeparator: "Bw==", rounds: 17, memoryCost: 14 },
      },
    });
    expect(await fetchHashConfig(account, "tok")).toBeNull();
    expect(captured.err).toContain(
      "won't work in Clerk (rounds must be a whole number from 1 to 16",
    );
  });

  test("returns null when the response carries no hash config", async () => {
    stubFirebase([[]], { signIn: {} });
    expect(await fetchHashConfig(account, "tok")).toBeNull();
  });
});

describe("formatHashConfigGuidance", () => {
  const config = { signerKey: "KEY==", saltSeparator: "Bw==", rounds: 8, memoryCost: 14 };

  // They are in the envelope now, so the import needs no flags for them.
  test("says the parameters travel in the export file when the project gave them", () => {
    const text = formatHashConfigGuidance(config, 3).join("\n");
    expect(text).toContain("saved in the export file");
    expect(text).not.toContain("--firebase-signer-key");
  });

  test("says where to find them when the project would not say", () => {
    const text = formatHashConfigGuidance(null, 3).join("\n");
    expect(text).toContain("Password hash parameters");
    expect(text).toContain("Authentication → Users");
    expect(text).toContain("--firebase-signer-key");
  });

  // Nothing to configure, so nothing to tell them to configure.
  test("says nothing is needed when the export has no hashes", () => {
    expect(formatHashConfigGuidance(null, 0).join("\n")).toContain("no hash parameters are needed");
  });
});

/** The envelope the one export run in this project wrote. */
function onlyExportFile(): string {
  const dir = path.join(workDir, ".clerk", "migrate");
  const entries = fs.readdirSync(dir);
  expect(entries).toHaveLength(1);
  return path.join(dir, entries[0] as string, "export.json");
}

/** The users inside that envelope. */
function exportedUsers(): Record<string, unknown>[] {
  return (
    JSON.parse(fs.readFileSync(onlyExportFile(), "utf-8")) as { users: Record<string, unknown>[] }
  ).users;
}

describe("exportFirebase", () => {
  // `-y` is "do not prompt", at a terminal too.
  test("does not ask for a service account key under -y", async () => {
    process.env.CLERK_MODE = "human";
    setAssumeYes(true);
    try {
      await expect(exportFirebase({})).rejects.toThrow(/cannot prompt here/);
    } finally {
      setAssumeYes(false);
    }
  });

  test("exports end to end and reports coverage", async () => {
    stubFirebase([[fbUser(0), fbUser(1)]], {
      signIn: { hashConfig: { signerKey: "K", saltSeparator: "S", rounds: 8, memoryCost: 14 } },
    });

    await exportFirebase({ serviceAccount: "./sa.json" });
    expect(JSON.parse(fs.readFileSync(onlyExportFile(), "utf-8"))).toMatchObject({
      source: "firebase",
    });
    const written = exportedUsers();
    expect(written).toHaveLength(2);
    expect(captured.err).toContain("Field coverage");
    expect(captured.err).toContain("demo-fb project");
  });

  // Firebase's own variable, so it's honoured, but an emulator's users are
  // not the project's: the target line says which.
  test("names the emulator in the target line when one is set", async () => {
    stubFirebase([[fbUser(0)]], { signIn: {} });
    process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
    try {
      await exportFirebase({ serviceAccount: "./sa.json" });
    } finally {
      delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    }
    expect(captured.err).toContain("Source: firebase (emulator at localhost:9099)");
  });

  test("names the command that consumes the file", async () => {
    stubFirebase([[fbUser(0)]], { signIn: {} });
    // The suggestion now rides the gutter's Next steps block, which only
    // renders in human mode.
    process.env.CLERK_MODE = "human";
    await exportFirebase({ serviceAccount: "./sa.json", output: "exports/mine.json" });
    expect(captured.err).toMatch(/clerk migrate import \d{8}-\d{6}-[0-9a-f]{4}/);
  });

  test("--output controls the destination", async () => {
    stubFirebase([[fbUser(0)]], { signIn: {} });
    await exportFirebase({ serviceAccount: "./sa.json", output: "fb.json" });
    expect(fs.existsSync(path.join(workDir, "fb.json"))).toBe(true);
  });

  // Human runs get a prompt instead; an agent has nobody to ask, so it is told
  // which flag to pass.
  test("agent mode names the flag rather than prompting", async () => {
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
