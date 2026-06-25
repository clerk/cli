import { test, expect, describe, mock } from "bun:test";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockIsAgent = mock();
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => !mockIsAgent(...args),
  setMode: () => {},
  getMode: () => "human",
}));

const { webhooksToken } = await import("./token.ts");

const TOKEN_RE = /^c_[0-9A-Za-z]{10}$/;

describe("webhooks token", () => {
  const captured = useCaptureLog();

  test("prints a valid bare relay token on stdout with a usage hint on stderr (human)", () => {
    mockIsAgent.mockReturnValue(false);
    webhooksToken({});

    const token = captured.out.trim();
    expect(token).toMatch(TOKEN_RE);
    expect(captured.err).toContain("--token");
    expect(captured.err).toContain(token); // hint references the same token
  });

  test("--json prints a { token } object and no hint", () => {
    mockIsAgent.mockReturnValue(false);
    webhooksToken({ json: true });

    const parsed = JSON.parse(captured.out) as { token: string };
    expect(parsed.token).toMatch(TOKEN_RE);
    expect(captured.err).toBe("");
  });

  test("agent mode still prints the BARE token (pipeable) with no hint", () => {
    // Command substitution `$(clerk webhooks token)` runs non-interactively, so
    // the bare token — not JSON — must be the default stdout output.
    mockIsAgent.mockReturnValue(true);
    webhooksToken({});

    expect(captured.out.trim()).toMatch(TOKEN_RE);
    expect(captured.err).toBe("");
  });

  test("successive calls produce different tokens", () => {
    mockIsAgent.mockReturnValue(false);
    webhooksToken({});
    const first = captured.out.trim().split("\n")[0];
    captured.clear();
    webhooksToken({});
    const second = captured.out.trim().split("\n")[0];

    expect(first).toMatch(TOKEN_RE);
    expect(second).toMatch(TOKEN_RE);
    expect(first).not.toBe(second);
  });
});
