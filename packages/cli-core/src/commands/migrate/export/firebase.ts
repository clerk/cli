/**
 * `clerk migrate export firebase` — pull users out of Firebase Authentication.
 *
 * Ported from the standalone migration-tool's `src/export/firebase.ts`, but
 * **without `firebase-admin`**.
 *
 * The spike the ticket asked for was run first, and it passed: a
 * `bun build --compile` binary imports `firebase-admin`, initializes it, and
 * completes `listUsers` against Identity Toolkit. The known Firestore-under-
 * compile bug does not reach the Auth Admin surface.
 *
 * The SDK was still not adopted, on the second measurement: it is **74 MB
 * across 158 packages**, including `@google-cloud/firestore` and
 * `@google-cloud/storage`, neither of which this command touches. The compiled
 * `clerk` binary is ~65 MB today, so that roughly doubles the artifact every
 * user downloads — to serve one subcommand.
 *
 * What the SDK actually does here is two REST calls and an RS256 JWT, and Bun's
 * Web Crypto signs RS256 with no dependency at all (verified compiled). So this
 * adds **zero** packages, and its HTTP goes through `loggedFetch`, so a
 * `--verbose` run shows the requests — which an SDK doing its own fetch would
 * not.
 */

import fs from "node:fs";
import path from "node:path";
import { CliError, ERROR_CODE, throwUsageError } from "../../../lib/errors.ts";
import { bold, dim } from "../../../lib/color.ts";
import { loggedFetch } from "../../../lib/fetch.ts";
import { log } from "../../../lib/log.ts";
import { withGutter, withSpinner, type SpinnerControls } from "../../../lib/spinner.ts";
import { exportLogger, getDateTimeStamp } from "../lib/logger.ts";
import { defaultOutputPath, reportExport, writeExportOutput } from "./shared.ts";

/** Identity Toolkit's maximum for `accounts:batchGet`. */
const PAGE_SIZE = 1000;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/firebase",
].join(" ");

const DOCS_URL = "https://clerk.com/docs/guides/development/migrating/firebase";

export type ExportFirebaseOptions = {
  serviceAccount?: string;
  output?: string;
};

export type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};

/**
 * Reads and validates a service-account key file.
 *
 * Every failure names the field, because the usual causes are downloading the
 * wrong JSON from the console (a web app config rather than a service account)
 * or pasting a key with its newlines mangled.
 */
export function readServiceAccount(file: string): ServiceAccount {
  const resolved = path.resolve(process.cwd(), file);

  if (!fs.existsSync(resolved)) {
    throw new CliError(`No service account file at ${resolved}.`, {
      code: ERROR_CODE.FILE_NOT_FOUND,
      docsUrl: DOCS_URL,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  } catch (error) {
    throw new CliError(`${file} is not valid JSON: ${(error as Error).message}`, {
      code: ERROR_CODE.INVALID_JSON,
      docsUrl: DOCS_URL,
    });
  }

  const account = parsed as Partial<ServiceAccount> & { type?: string };
  const invalid = (problem: string): never => {
    throw new CliError(`${file} is not a usable service account key: ${problem}`, {
      code: ERROR_CODE.USAGE_ERROR,
      docsUrl: DOCS_URL,
    });
  };

  if (account.type && account.type !== "service_account") {
    invalid(
      `its "type" is "${account.type}", not "service_account". Download a private key from ` +
        "Project settings → Service accounts → Generate new private key.",
    );
  }
  for (const field of ["project_id", "client_email", "private_key"] as const) {
    if (typeof account[field] !== "string" || account[field].length === 0) {
      invalid(`"${field}" is missing`);
    }
  }
  if (!account.private_key?.includes("PRIVATE KEY")) {
    invalid('"private_key" does not look like a PEM key — check its newlines survived copying');
  }

  return account as ServiceAccount;
}

function base64Url(input: string | Uint8Array): string {
  const binary =
    typeof input === "string" ? input : String.fromCharCode(...(input as unknown as number[]));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Imports the PEM private key for RS256 signing. */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  let der: Uint8Array<ArrayBuffer>;
  try {
    der = Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
  } catch {
    throw new CliError("The service account's private_key is not valid base64.", {
      code: ERROR_CODE.USAGE_ERROR,
      docsUrl: DOCS_URL,
    });
  }

  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (error) {
    throw new CliError(
      `The service account's private_key could not be read: ${(error as Error).message}`,
      { code: ERROR_CODE.USAGE_ERROR, docsUrl: DOCS_URL },
    );
  }
}

/**
 * Signs the assertion Google exchanges for an access token.
 *
 * @param now - Seconds since the epoch; injectable so tests are not clock-bound.
 */
export async function signServiceAccountJwt(
  account: ServiceAccount,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const key = await importPrivateKey(account.private_key);
  const claims = {
    iss: account.client_email,
    scope: SCOPES,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const body = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(JSON.stringify(claims))}`;

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(body),
  );

  return `${body}.${base64Url(new Uint8Array(signature))}`;
}

/**
 * Exchanges the signed assertion for an Identity Toolkit access token.
 *
 * Against the emulator there is nothing to exchange with — Google's token
 * endpoint is not part of it — so the run uses the `owner` bearer the emulator
 * accepts, matching what `firebase-admin` does.
 */
export async function fetchAccessToken(account: ServiceAccount): Promise<string> {
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST) return "owner";

  const assertion = await signServiceAccountJwt(account);

  const response = await loggedFetch(new URL(TOKEN_URL), {
    tag: "firebase",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });

  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error_description?: string;
    error?: string;
  };

  if (!response.ok || !body.access_token) {
    throw new CliError(
      `Google rejected the service account (${response.status}): ${body.error_description ?? body.error ?? "no access token returned"}\n` +
        "Check the key has not been revoked, and that the service account has the Firebase Authentication Admin role.",
      { code: ERROR_CODE.USAGE_ERROR, docsUrl: DOCS_URL },
    );
  }

  return body.access_token;
}

/**
 * Base URL for Identity Toolkit.
 *
 * Honours `FIREBASE_AUTH_EMULATOR_HOST`, the variable Firebase's own tooling
 * uses, so this works against the local emulator as well as production.
 */
function identityToolkitBase(): string {
  const emulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  return emulator
    ? `http://${emulator}/identitytoolkit.googleapis.com`
    : "https://identitytoolkit.googleapis.com";
}

export type FirebaseUser = Record<string, unknown> & { localId?: string };

/** Pages through every user in the project. */
export async function fetchAllFirebaseUsers(options: {
  account: ServiceAccount;
  token: string;
  spinner?: SpinnerControls;
}): Promise<FirebaseUser[]> {
  const all: FirebaseUser[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(
      `${identityToolkitBase()}/v1/projects/${options.account.project_id}/accounts:batchGet`,
    );
    url.searchParams.set("maxResults", String(PAGE_SIZE));
    if (pageToken) url.searchParams.set("nextPageToken", pageToken);

    const response = await loggedFetch(url, {
      tag: "firebase",
      method: "GET",
      headers: { Authorization: `Bearer ${options.token}`, Accept: "application/json" },
    });

    if (!response.ok) {
      throw new CliError(
        `Firebase returned ${response.status} listing users: ${await response.text()}`,
        { code: ERROR_CODE.USAGE_ERROR, docsUrl: DOCS_URL },
      );
    }

    const body = (await response.json()) as { users?: FirebaseUser[]; nextPageToken?: string };
    all.push(...(body.users ?? []));
    options.spinner?.update(`Fetching users from Firebase: ${all.length} so far...`);
    pageToken = body.nextPageToken;
  } while (pageToken);

  return all;
}

export type HashConfig = {
  signerKey: string;
  saltSeparator: string;
  rounds: number;
  memoryCost: number;
};

/**
 * Reads the project's scrypt parameters.
 *
 * These are the whole reason a Firebase migration keeps its passwords: without
 * them Clerk cannot verify a single digest. Fetching them here saves the user
 * hunting through the console — and if the call is not permitted, the run says
 * exactly where to look instead.
 *
 * @returns `null` when the config could not be read.
 */
export async function fetchHashConfig(
  account: ServiceAccount,
  token: string,
): Promise<HashConfig | null> {
  try {
    const url = new URL(`${identityToolkitBase()}/admin/v2/projects/${account.project_id}/config`);
    const response = await loggedFetch(url, {
      tag: "firebase",
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!response.ok) {
      log.debug(`firebase: ${response.status} reading the project config`);
      return null;
    }

    const body = (await response.json()) as {
      signIn?: { hashConfig?: Partial<HashConfig> & { algorithm?: string } };
    };
    const config = body.signIn?.hashConfig;
    if (!config?.signerKey || !config.saltSeparator) return null;

    return {
      signerKey: config.signerKey,
      saltSeparator: config.saltSeparator,
      rounds: Number(config.rounds ?? 8),
      memoryCost: Number(config.memoryCost ?? 14),
    };
  } catch (error) {
    log.debug(`firebase: could not read the project config: ${String(error)}`);
    return null;
  }
}

/**
 * Keeps the fields the `firebase` transformer maps from.
 *
 * A Firebase user also carries provider records, custom claims and sign-in
 * timestamps that would bloat the export and mean nothing to the import.
 */
export function mapFirebaseUserToExport(user: FirebaseUser): Record<string, unknown> {
  const exported: Record<string, unknown> = {};

  for (const field of ["localId", "email", "displayName", "phoneNumber", "createdAt"] as const) {
    if (user[field]) exported[field] = user[field];
  }
  // Meaningful when false, so copied on presence rather than truthiness.
  if (user.emailVerified !== undefined) exported.emailVerified = user.emailVerified;

  // Both halves or neither: a digest without its salt cannot be verified.
  if (user.passwordHash && user.salt) {
    exported.passwordHash = user.passwordHash;
    exported.salt = user.salt;
  }

  return exported;
}

export function buildFirebaseExport(users: FirebaseUser[], dateTime: string) {
  const exported: Record<string, unknown>[] = [];
  const counts = { email: 0, verified: 0, password: 0, name: 0, phone: 0 };

  for (const user of users) {
    const userId = String(user.localId ?? "");
    try {
      const mapped = mapFirebaseUserToExport(user);
      exported.push(mapped);

      if (mapped.email) counts.email++;
      if (mapped.emailVerified) counts.verified++;
      if (mapped.passwordHash) counts.password++;
      if (mapped.displayName) counts.name++;
      if (mapped.phoneNumber) counts.phone++;

      exportLogger({ userId, status: "success" }, dateTime);
    } catch (error) {
      exportLogger({ userId, status: "error", error: (error as Error).message }, dateTime);
    }
  }

  return {
    users: exported,
    coverage: [
      { label: "have an email address", count: counts.email },
      { label: "have a verified email", count: counts.verified },
      { label: "have a password hash", count: counts.password },
      { label: "have a display name", count: counts.name },
      { label: "have a phone number", count: counts.phone },
    ],
  };
}

/** The exact `migrate run` invocation, with the project's own parameters. */
export function formatHashConfigGuidance(
  config: HashConfig | null,
  outputPath: string,
  passwordCount: number,
): string[] {
  if (passwordCount === 0) {
    return [dim("No password hashes in this export, so no hash parameters are needed.")];
  }

  if (!config) {
    return [
      bold("Password hash parameters"),
      "This export carries password hashes, which Clerk can only verify with the project's",
      "scrypt parameters. Find them in the Firebase console under",
      "Authentication → Users → (⋮) → Password hash parameters, then pass:",
      dim(
        "  --firebase-signer-key --firebase-salt-separator --firebase-rounds --firebase-mem-cost",
      ),
    ];
  }

  return [
    bold("Password hash parameters"),
    "Read from the project. Import with:",
    dim(
      `  clerk migrate run -y --transformer firebase --file ${outputPath} \\\n` +
        `    --firebase-signer-key "${config.signerKey}" \\\n` +
        `    --firebase-salt-separator "${config.saltSeparator}" \\\n` +
        `    --firebase-rounds ${config.rounds} --firebase-mem-cost ${config.memoryCost}`,
    ),
  ];
}

export async function exportFirebase(options: ExportFirebaseOptions): Promise<void> {
  if (!options.serviceAccount) {
    throwUsageError(
      "`clerk migrate export firebase` needs a service account key file. Pass --service-account <path>.",
      DOCS_URL,
      undefined,
      [
        {
          command: "clerk migrate export firebase --service-account ./service-account.json",
          description: "Export using a downloaded service account key",
        },
      ],
    );
  }

  // Read and validate before anything reaches the network, so a wrong file
  // fails in a second rather than after an auth round-trip.
  const account = readServiceAccount(options.serviceAccount);

  await withGutter("Exporting users from Firebase", async ({ setNextSteps }) => {
    const dateTime = getDateTimeStamp();
    log.info(`Exporting from the ${account.project_id} project.`);

    const token = await withSpinner("Authenticating with Google...", () =>
      fetchAccessToken(account),
    );

    const users = await withSpinner("Fetching users from Firebase...", (spinner) =>
      fetchAllFirebaseUsers({ account, token, spinner }),
    );

    const { users: exported, coverage } = buildFirebaseExport(users, dateTime);
    const outputPath = writeExportOutput(exported, options.output ?? defaultOutputPath("firebase"));

    setNextSteps(
      reportExport({
        platform: "firebase",
        userCount: exported.length,
        outputPath,
        coverage,
        transformerKey: "firebase",
      }),
    );

    const passwordCount = coverage.find((entry) => entry.label.includes("password"))?.count ?? 0;
    const hashConfig = passwordCount > 0 ? await fetchHashConfig(account, token) : null;

    log.blank();
    for (const line of formatHashConfigGuidance(hashConfig, outputPath, passwordCount)) {
      log.info(line);
    }
  });
}
