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

  test("prints the bare token on stdout and a Next steps block on stderr (human)", async () => {
    mockIsAgent.mockReturnValue(false);
    await webhooksToken({});

    const token = captured.out.trim();
    expect(token).toMatch(TOKEN_RE);
    expect(captured.err).toContain("Next steps");
    expect(captured.err).toContain("Pin it:");
    expect(captured.err).toContain(`--token ${token}`); // step references the same token
  });

  test("--json prints a { token } object and no Next steps", async () => {
    mockIsAgent.mockReturnValue(false);
    await webhooksToken({ json: true });

    const parsed = JSON.parse(captured.out) as { token: string };
    expect(parsed.token).toMatch(TOKEN_RE);
    expect(captured.err).toBe("");
  });

  test("agent mode still prints the BARE token (pipeable) with no Next steps", async () => {
    // Command substitution `$(clerk webhooks token)` runs non-interactively, so
    // the bare token — not JSON — must be the default stdout output.
    mockIsAgent.mockReturnValue(true);
    await webhooksToken({});

    expect(captured.out.trim()).toMatch(TOKEN_RE);
    expect(captured.err).toBe("");
  });

  test("successive calls produce different tokens", async () => {
    mockIsAgent.mockReturnValue(false);
    await webhooksToken({});
    const first = captured.out.trim().split("\n")[0];
    captured.clear();
    await webhooksToken({});
    const second = captured.out.trim().split("\n")[0];

    expect(first).toMatch(TOKEN_RE);
    expect(second).toMatch(TOKEN_RE);
    expect(first).not.toBe(second);
  });
});
