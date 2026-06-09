import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import {
  decodeWebhookSecret,
  parseDeliveryLine,
  verifyWebhookSignature,
  webhooksVerify,
} from "./verify.ts";

const KEY = randomBytes(24);
const SECRET = `whsec_${KEY.toString("base64")}`;
const ID = "msg_2xyz";
const TIMESTAMP = String(Math.floor(Date.now() / 1000));
const PAYLOAD = '{"object":"event","type":"user.created"}';

function sign(id: string, timestamp: string, payload: string, key: Buffer = KEY): string {
  return createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`, "utf8").digest("base64");
}

const VALID_SIGNATURE = `v1,${sign(ID, TIMESTAMP, PAYLOAD)}`;

describe("decodeWebhookSecret", () => {
  test.each([
    { label: "valid whsec_ secret", secret: SECRET, expected: true },
    { label: "missing whsec_ prefix", secret: KEY.toString("base64"), expected: false },
    { label: "empty suffix", secret: "whsec_", expected: false },
    { label: "empty string", secret: "", expected: false },
  ])("$label", ({ secret, expected }) => {
    const key = decodeWebhookSecret(secret);
    expect(key !== null).toBe(expected);
    if (key) expect(key.equals(KEY)).toBe(true);
  });
});

describe("verifyWebhookSignature", () => {
  const base = { secret: SECRET, id: ID, timestamp: TIMESTAMP, payload: PAYLOAD };

  test("accepts a valid single signature", () => {
    expect(verifyWebhookSignature({ ...base, signature: VALID_SIGNATURE })).toBe(true);
  });

  test("accepts when any space-separated entry matches (rotation grace window)", () => {
    const oldKey = randomBytes(24);
    const staleEntry = `v1,${sign(ID, TIMESTAMP, PAYLOAD, oldKey)}`;
    expect(verifyWebhookSignature({ ...base, signature: `${staleEntry} ${VALID_SIGNATURE}` })).toBe(
      true,
    );
  });

  test.each([
    { label: "tampered body", input: { ...base, payload: PAYLOAD + " " } },
    { label: "wrong timestamp", input: { ...base, timestamp: String(Number(TIMESTAMP) + 1) } },
    { label: "wrong id", input: { ...base, id: "msg_other" } },
    {
      label: "wrong secret",
      input: { ...base, secret: `whsec_${randomBytes(24).toString("base64")}` },
    },
  ])("rejects $label", ({ input }) => {
    expect(verifyWebhookSignature({ ...input, signature: VALID_SIGNATURE })).toBe(false);
  });

  test.each([
    { label: "non-v1 version entries", signature: `v1a,${sign(ID, TIMESTAMP, PAYLOAD)}` },
    { label: "entry without a comma", signature: "v1" },
    { label: "empty header", signature: "" },
    { label: "whitespace-only header", signature: "   " },
    { label: "truncated base64 signature", signature: "v1,AAAA" },
    { label: "garbage entry", signature: "v1,!!!not-base64!!!" },
  ])("rejects $label without crashing", ({ signature }) => {
    expect(verifyWebhookSignature({ ...base, signature })).toBe(false);
  });

  test("rejects everything when the secret is malformed", () => {
    expect(
      verifyWebhookSignature({ ...base, secret: "not-a-secret", signature: VALID_SIGNATURE }),
    ).toBe(false);
  });
});

describe("parseDeliveryLine", () => {
  test("extracts the four fields from a listen event line", () => {
    const line = JSON.stringify({
      type: "event",
      svix_id: ID,
      event_type: "user.created",
      headers: {
        "svix-id": ID,
        "svix-timestamp": TIMESTAMP,
        "svix-signature": VALID_SIGNATURE,
      },
      body_b64: Buffer.from(PAYLOAD, "utf8").toString("base64"),
      forward_status: 200,
      latency_ms: 12,
    });

    expect(parseDeliveryLine(line)).toEqual({
      id: ID,
      timestamp: TIMESTAMP,
      signature: VALID_SIGNATURE,
      payload: PAYLOAD,
    });
  });

  test.each([
    { label: "invalid JSON", raw: "{nope" },
    { label: "non-object JSON", raw: '"hello"' },
  ])("throws a usage error on $label", ({ raw }) => {
    expect(() => parseDeliveryLine(raw)).toThrow(CliError);
  });

  test("returns undefined fields when headers are missing", () => {
    expect(parseDeliveryLine("{}")).toEqual({
      id: undefined,
      timestamp: undefined,
      signature: undefined,
    });
  });
});

describe("webhooks verify command", () => {
  const captured = useCaptureLog();
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-verify-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeTempFile(name: string, content: string): Promise<string> {
    const path = join(tempDir, name);
    await writeFile(path, content);
    return path;
  }

  const explicitFlags = () => ({
    secret: SECRET,
    id: ID,
    timestamp: TIMESTAMP,
    signature: VALID_SIGNATURE,
  });

  test("verifies with explicit flags and a payload file", async () => {
    const payloadPath = await writeTempFile("body.json", PAYLOAD);

    await webhooksVerify({ ...explicitFlags(), payload: `@${payloadPath}` });

    expect(captured.err).toContain("Signature verified.");
    expect(captured.out).toBe("");
  });

  test("verifies from a --delivery event file alone", async () => {
    const line = JSON.stringify({
      headers: { "svix-id": ID, "svix-timestamp": TIMESTAMP, "svix-signature": VALID_SIGNATURE },
      body_b64: Buffer.from(PAYLOAD, "utf8").toString("base64"),
    });
    const deliveryPath = await writeTempFile("event.json", `${line}\n`);

    await webhooksVerify({ secret: SECRET, delivery: `@${deliveryPath}` });

    expect(captured.err).toContain("Signature verified.");
  });

  test("explicit flags override --delivery fields", async () => {
    const line = JSON.stringify({
      headers: {
        "svix-id": "msg_other",
        "svix-timestamp": TIMESTAMP,
        "svix-signature": VALID_SIGNATURE,
      },
      body_b64: Buffer.from(PAYLOAD, "utf8").toString("base64"),
    });
    const deliveryPath = await writeTempFile("event.json", line);

    // The file's svix-id would fail; the explicit --id matching the signature wins.
    await webhooksVerify({ secret: SECRET, delivery: `@${deliveryPath}`, id: ID });

    expect(captured.err).toContain("Signature verified.");
  });

  test("fails with exit 1 on a signature mismatch", async () => {
    const payloadPath = await writeTempFile("body.json", PAYLOAD + "tampered");

    await expect(
      webhooksVerify({ ...explicitFlags(), payload: `@${payloadPath}` }),
    ).rejects.toThrow("Signature verification failed");
  });

  test("mismatch on a stale timestamp includes a humanized skew hint", async () => {
    const staleTimestamp = String(Number(TIMESTAMP) - 3600);
    const payloadPath = await writeTempFile("body.json", PAYLOAD);

    await expect(
      webhooksVerify({ ...explicitFlags(), timestamp: staleTimestamp, payload: `@${payloadPath}` }),
    ).rejects.toThrow("in the past");
  });

  test.each([
    { label: "missing --secret", options: {} },
    { label: "malformed --secret", options: { secret: "sk_nope" } },
    {
      label: "missing inputs (no --delivery, incomplete flags)",
      options: { secret: SECRET, id: ID },
    },
    {
      label: "non-integer --timestamp",
      options: {
        secret: SECRET,
        id: ID,
        timestamp: "2026-06-09T12:00:00Z",
        signature: VALID_SIGNATURE,
        payload: "-",
      },
    },
    {
      label: "inline --payload (not @file or -)",
      options: {
        secret: SECRET,
        id: ID,
        timestamp: TIMESTAMP,
        signature: VALID_SIGNATURE,
        payload: "{}",
      },
    },
  ])("$label is a usage error", async ({ options }) => {
    await expect(webhooksVerify(options)).rejects.toMatchObject({
      code: ERROR_CODE.USAGE_ERROR,
    });
  });

  test("missing --payload file maps to file_not_found", async () => {
    await expect(
      webhooksVerify({ ...explicitFlags(), payload: "@/definitely/not/here.json" }),
    ).rejects.toMatchObject({ code: ERROR_CODE.FILE_NOT_FOUND });
  });

  test("empty --delivery input is a usage error", async () => {
    const deliveryPath = await writeTempFile("empty.json", "\n\n");

    await expect(
      webhooksVerify({ secret: SECRET, delivery: `@${deliveryPath}` }),
    ).rejects.toMatchObject({ code: ERROR_CODE.USAGE_ERROR });
  });
});
