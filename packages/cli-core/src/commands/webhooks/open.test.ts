import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { CliError, PlapiError } from "../../lib/errors.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockGetWebhookPortalUrl = mock();
mock.module("../../lib/plapi.ts", () => ({
  getWebhookPortalUrl: (...args: unknown[]) => mockGetWebhookPortalUrl(...args),
}));

const mockResolveAppContext = mock();
mock.module("../../lib/config.ts", () => ({
  resolveAppContext: (...args: unknown[]) => mockResolveAppContext(...args),
  getRelayEntry: async () => undefined,
}));

const mockIsAgent = mock();
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => !mockIsAgent(...args),
  setMode: () => {},
  getMode: () => "human",
}));

const mockOpenBrowser = mock();
mock.module("../../lib/open.ts", () => ({
  openBrowser: (...args: unknown[]) => mockOpenBrowser(...args),
}));

const { webhooksOpen } = await import("./open.ts");

const PORTAL_URL = "https://app.svix.com/login#key=abc";

describe("webhooks open", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockResolveAppContext.mockResolvedValue({
      appId: "app_1",
      appLabel: "My App",
      instanceId: "ins_1",
      instanceLabel: "development",
    });
    mockGetWebhookPortalUrl.mockResolvedValue({ url: PORTAL_URL });
    mockOpenBrowser.mockResolvedValue({ ok: true, launcher: "open" });
  });

  afterEach(() => {
    mockGetWebhookPortalUrl.mockReset();
    mockResolveAppContext.mockReset();
    mockIsAgent.mockReset();
    mockOpenBrowser.mockReset();
  });

  test("fetches the portal URL and opens the browser in human mode", async () => {
    await webhooksOpen();

    expect(mockGetWebhookPortalUrl).toHaveBeenCalledWith("app_1", "ins_1");
    expect(mockOpenBrowser).toHaveBeenCalledWith(PORTAL_URL);
    expect(captured.out).toBe("");
    expect(captured.err).toContain("Opening the webhook portal");
  });

  test("prints a fallback URL when the browser cannot be opened", async () => {
    mockOpenBrowser.mockResolvedValue({ ok: false, reason: "no-launcher" });

    await webhooksOpen();

    expect(captured.err).toContain("Could not open your browser automatically");
    expect(captured.err).toContain(PORTAL_URL);
  });

  test("outputs { url } without launching a browser with --json", async () => {
    await webhooksOpen({ json: true });

    expect(JSON.parse(captured.out)).toEqual({ url: PORTAL_URL });
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("outputs { url } without launching a browser in agent mode", async () => {
    mockIsAgent.mockReturnValue(true);

    await webhooksOpen();

    expect(JSON.parse(captured.out)).toEqual({ url: PORTAL_URL });
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("throws a friendly CliError when no Svix app exists yet (svix_app_missing)", async () => {
    mockGetWebhookPortalUrl.mockRejectedValue(
      new PlapiError(
        400,
        JSON.stringify({
          errors: [
            {
              code: "svix_app_missing",
              message: "No Svix apps are associated with the current instance.",
            },
          ],
        }),
      ),
    );

    const error = await webhooksOpen().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("No webhooks configured yet");
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });
});
