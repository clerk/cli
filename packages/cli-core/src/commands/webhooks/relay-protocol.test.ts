import { test, expect, describe } from "bun:test";
import {
  decodeEventBody,
  decodeFrame,
  encodeEventResponseFrame,
  encodeStartFrame,
  generateRelayToken,
  relayReceiveUrl,
} from "./relay-protocol.ts";

describe("generateRelayToken", () => {
  test("produces 10 base62 chars with no prefix", () => {
    const token = generateRelayToken();
    expect(token).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(token.startsWith("c_")).toBe(false);
  });

  test("produces distinct tokens across calls", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateRelayToken()));
    expect(tokens.size).toBe(50);
  });
});

describe("relayReceiveUrl", () => {
  test("builds the play.svix.com URL with the raw token", () => {
    expect(relayReceiveUrl("Ab12Cd34Ef")).toBe("https://play.svix.com/in/Ab12Cd34Ef/");
  });
});

describe("encodeStartFrame", () => {
  test("matches the svix-cli handshake shape", () => {
    expect(JSON.parse(encodeStartFrame("Ab12Cd34Ef"))).toEqual({
      type: "start",
      version: 1,
      data: { token: "Ab12Cd34Ef" },
    });
  });
});

describe("decodeFrame", () => {
  const eventFrame = JSON.stringify({
    type: "event",
    version: 1,
    data: {
      id: "frame_1",
      method: "POST",
      headers: { "svix-id": "msg_1", "svix-timestamp": "1717935000", "svix-signature": "v1,abc" },
      body: Buffer.from('{"type":"user.created"}', "utf8").toString("base64"),
    },
  });

  test("decodes an event frame", () => {
    const decoded = decodeFrame(eventFrame);
    expect(decoded.type).toBe("event");
    if (decoded.type !== "event") throw new Error("unreachable");
    expect(decoded.event.id).toBe("frame_1");
    expect(decoded.event.method).toBe("POST");
    expect(decoded.event.headers["svix-id"]).toBe("msg_1");
    expect(decodeEventBody(decoded.event)).toBe('{"type":"user.created"}');
  });

  test("round-trips: a decoded event re-encodes into a valid response frame", () => {
    const decoded = decodeFrame(eventFrame);
    if (decoded.type !== "event") throw new Error("unreachable");

    const reply = encodeEventResponseFrame({
      id: decoded.event.id,
      status: 200,
      headers: { "content-type": "application/json" },
      bodyB64: Buffer.from("{}", "utf8").toString("base64"),
    });

    expect(JSON.parse(reply)).toEqual({
      type: "event",
      version: 1,
      data: {
        id: "frame_1",
        status: 200,
        headers: { "content-type": "application/json" },
        body: "e30=",
      },
    });
  });

  test.each([
    { label: "invalid JSON", raw: "{nope" },
    { label: "non-object JSON", raw: '"hello"' },
    { label: "null", raw: "null" },
    { label: "unknown frame type", raw: '{"type":"server-error","version":1,"data":{}}' },
    { label: "event frame without data", raw: '{"type":"event","version":1}' },
    { label: "event frame without an id", raw: '{"type":"event","version":1,"data":{}}' },
  ])("returns unknown for $label", ({ raw }) => {
    expect(decodeFrame(raw)).toEqual({ type: "unknown" });
  });

  test("defaults method to POST and headers/body to empty", () => {
    const decoded = decodeFrame('{"type":"event","version":1,"data":{"id":"frame_2"}}');
    if (decoded.type !== "event") throw new Error("unreachable");
    expect(decoded.event.method).toBe("POST");
    expect(decoded.event.headers).toEqual({});
    expect(decoded.event.bodyB64).toBe("");
    expect(decodeEventBody(decoded.event)).toBe("");
  });
});
