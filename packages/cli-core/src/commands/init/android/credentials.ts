import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { throwUsageError } from "../../../lib/errors.ts";
import { password, text } from "../../../lib/prompts.ts";
import type { GoogleCredentials } from "./native-google.ts";

const CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

/** A Google Web client ID as Google Cloud issues them. */
export function validGoogleClientId(value: string | undefined): value is string {
  return !!value && CLIENT_ID.test(value.trim());
}

function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(join(homedir(), path.slice(2)));
  return resolve(path);
}

/**
 * The secret, or a whole Web client, from a file the user controls: a Google Cloud Console OAuth
 * client JSON download (its `web` or `installed` object), a JSON `{ client_id, client_secret }`,
 * or the bare secret. `-` reads standard input, so an agent never puts the secret on a command
 * line. Nothing read here is logged.
 */
export async function readGoogleSecretFile(
  path: string,
  stdin: () => Promise<string> = async () => Bun.stdin.text(),
): Promise<{ clientId?: string; clientSecret: string }> {
  let contents: string;
  if (path.trim() === "-") contents = await stdin();
  else {
    const file = Bun.file(expandPath(path.trim()));
    if (!(await file.exists())) throwUsageError(`--google-client-secret-file: no file at ${path}.`);
    contents = await file.text();
  }
  const trimmed = contents.trim();
  if (!trimmed) throwUsageError("--google-client-secret-file: the file is empty.");
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throwUsageError("--google-client-secret-file: the file is not valid JSON.");
    }
    const root = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const client = (root.web ?? root.installed ?? root) as Record<string, unknown>;
    if (typeof client.client_secret !== "string" || !client.client_secret.trim())
      throwUsageError(
        '--google-client-secret-file: expected a Google Cloud OAuth client JSON download (a "web" object) or {"client_id","client_secret"}.',
      );
    return {
      ...(typeof client.client_id === "string" && client.client_id.trim()
        ? { clientId: client.client_id.trim() }
        : {}),
      clientSecret: client.client_secret.trim(),
    };
  }
  if (/\s/.test(trimmed))
    throwUsageError(
      "--google-client-secret-file: expected one client secret, or an OAuth client JSON download.",
    );
  return { clientSecret: trimmed };
}

/**
 * Resolves the Web client from the flags: both parts, one part with the other from the file, or
 * nothing. A client ID without a secret (or the reverse) is a usage error.
 */
export async function googleCredentialsFromFlags(options: {
  googleClientId?: string;
  googleClientSecretFile?: string;
}): Promise<GoogleCredentials | undefined> {
  if (!options.googleClientId && !options.googleClientSecretFile) return undefined;
  const file = options.googleClientSecretFile
    ? await readGoogleSecretFile(options.googleClientSecretFile)
    : undefined;
  const clientId = options.googleClientId?.trim() ?? file?.clientId;
  if (!file)
    throwUsageError(
      "--google-client-id needs the matching secret: pass --google-client-secret-file <path>, or - to read it from standard input.",
    );
  if (!clientId)
    throwUsageError(
      "--google-client-secret-file holds a secret but no client ID; pass --google-client-id too.",
    );
  if (!validGoogleClientId(clientId))
    throwUsageError(
      `--google-client-id must be a Google Web client ID ending in .apps.googleusercontent.com; got "${clientId}".`,
    );
  return { clientId, clientSecret: file.clientSecret };
}

/** Asks for the Web client at a terminal; the secret is masked and never echoed. */
export async function promptGoogleCredentials(): Promise<GoogleCredentials> {
  const clientId = (
    await text({
      message: "Google Web client ID (from Google Cloud Console):",
      validate: (value) =>
        validGoogleClientId(value) ||
        "Enter the Web application client ID, ending in .apps.googleusercontent.com.",
    })
  ).trim();
  const clientSecret = (
    await password({
      message: "Google Web client secret:",
      validate: (value) => (value?.trim().length ?? 0) > 0 || "The client secret is required.",
    })
  ).trim();
  return { clientId, clientSecret };
}
