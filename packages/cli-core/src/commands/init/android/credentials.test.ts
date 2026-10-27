import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  googleCredentialsFromFlags,
  readGoogleSecretFile,
  validGoogleClientId,
} from "./credentials.ts";
import { FAKE_GOOGLE_CLIENT_ID, FAKE_GOOGLE_CLIENT_SECRET } from "./test-helpers.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function file(contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clerk-google-"));
  roots.push(root);
  const path = join(root, "secret");
  await writeFile(path, contents);
  return path;
}

describe("Google Web client credentials", () => {
  test("recognizes Web client IDs", () => {
    expect(validGoogleClientId(FAKE_GOOGLE_CLIENT_ID)).toBe(true);
    expect(validGoogleClientId("not-a-client")).toBe(false);
    expect(validGoogleClientId(undefined)).toBe(false);
  });

  test("reads a bare secret, a Google Cloud download, or a plain JSON object", async () => {
    expect(await readGoogleSecretFile(await file(`${FAKE_GOOGLE_CLIENT_SECRET}\n`))).toEqual({
      clientSecret: FAKE_GOOGLE_CLIENT_SECRET,
    });
    expect(
      await readGoogleSecretFile(
        await file(
          JSON.stringify({
            web: {
              client_id: FAKE_GOOGLE_CLIENT_ID,
              client_secret: FAKE_GOOGLE_CLIENT_SECRET,
              redirect_uris: [],
            },
          }),
        ),
      ),
    ).toEqual({ clientId: FAKE_GOOGLE_CLIENT_ID, clientSecret: FAKE_GOOGLE_CLIENT_SECRET });
    expect(
      await readGoogleSecretFile(
        await file(JSON.stringify({ client_secret: FAKE_GOOGLE_CLIENT_SECRET })),
      ),
    ).toEqual({ clientSecret: FAKE_GOOGLE_CLIENT_SECRET });
  });

  test("reads standard input for -", async () => {
    expect(await readGoogleSecretFile("-", async () => `${FAKE_GOOGLE_CLIENT_SECRET}\n`)).toEqual({
      clientSecret: FAKE_GOOGLE_CLIENT_SECRET,
    });
  });

  test("rejects missing, empty, or malformed files", async () => {
    await expect(readGoogleSecretFile("/nonexistent/secret")).rejects.toThrow("no file at");
    await expect(readGoogleSecretFile(await file("  \n"))).rejects.toThrow("empty");
    await expect(readGoogleSecretFile(await file("{not json"))).rejects.toThrow("not valid JSON");
    await expect(readGoogleSecretFile(await file('{"web":{"client_id":"x"}}'))).rejects.toThrow(
      "client_secret",
    );
    await expect(readGoogleSecretFile(await file("two words"))).rejects.toThrow(
      "one client secret",
    );
  });

  test("resolves the flags together and refuses half a client", async () => {
    expect(await googleCredentialsFromFlags({})).toBeUndefined();
    const secret = await file(FAKE_GOOGLE_CLIENT_SECRET);
    expect(
      await googleCredentialsFromFlags({
        googleClientId: FAKE_GOOGLE_CLIENT_ID,
        googleClientSecretFile: secret,
      }),
    ).toEqual({
      clientId: FAKE_GOOGLE_CLIENT_ID,
      clientSecret: FAKE_GOOGLE_CLIENT_SECRET,
    });
    const download = await file(
      JSON.stringify({
        web: { client_id: FAKE_GOOGLE_CLIENT_ID, client_secret: FAKE_GOOGLE_CLIENT_SECRET },
      }),
    );
    expect((await googleCredentialsFromFlags({ googleClientSecretFile: download }))?.clientId).toBe(
      FAKE_GOOGLE_CLIENT_ID,
    );
    await expect(
      googleCredentialsFromFlags({ googleClientId: FAKE_GOOGLE_CLIENT_ID }),
    ).rejects.toThrow("--google-client-secret-file");
    await expect(googleCredentialsFromFlags({ googleClientSecretFile: secret })).rejects.toThrow(
      "--google-client-id too",
    );
    await expect(
      googleCredentialsFromFlags({ googleClientId: "bad", googleClientSecretFile: secret }),
    ).rejects.toThrow("apps.googleusercontent.com");
  });
});
