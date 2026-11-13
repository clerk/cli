import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

import { DEFAULT_FIRST_APPLICATION_NAME } from "./constants.ts";
import { PlapiError } from "./errors.ts";
import { useCaptureLog } from "../test/lib/stubs.ts";

// Mock the plapi module so the tests don't hit a real server. Match the
// project convention used elsewhere (see apps/create.test.ts, apps/list.test.ts).
const mockListApplications = mock();
const mockCreateApplication = mock();
mock.module("./plapi.ts", () => ({
  listApplications: (...args: unknown[]) => mockListApplications(...args),
  createApplication: (...args: unknown[]) => mockCreateApplication(...args),
}));

const { ensureFirstApplication } = await import("./first-application.ts");

describe("ensureFirstApplication", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    mockListApplications.mockReset();
    mockCreateApplication.mockReset();
    mockListApplications.mockResolvedValue([]);
    mockCreateApplication.mockImplementation((name: string) =>
      Promise.resolve({ application_id: `app_${name}` }),
    );
  });

  afterEach(() => {
    mockListApplications.mockReset();
    mockCreateApplication.mockReset();
  });

  it("creates a default app when the user has zero applications", async () => {
    mockListApplications.mockResolvedValue([]);
    await ensureFirstApplication();
    expect(mockCreateApplication).toHaveBeenCalledTimes(1);
    expect(mockCreateApplication).toHaveBeenCalledWith(DEFAULT_FIRST_APPLICATION_NAME);
  });

  it("does not create when the user already has applications", async () => {
    mockListApplications.mockResolvedValue([{ application_id: "app_existing" }]);
    await ensureFirstApplication();
    expect(mockCreateApplication).not.toHaveBeenCalled();
  });

  it("swallows listApplications errors", async () => {
    mockListApplications.mockRejectedValue(new Error("boom"));
    await expect(ensureFirstApplication()).resolves.toBeUndefined();
    expect(mockCreateApplication).not.toHaveBeenCalled();
  });

  it("swallows createApplication errors", async () => {
    mockCreateApplication.mockRejectedValue(new Error("boom"));
    await expect(ensureFirstApplication()).resolves.toBeUndefined();
  });

  it("suggests `clerk apps create` when the setup fails for another reason", async () => {
    mockListApplications.mockRejectedValue(new Error("boom"));
    await ensureFirstApplication();
    expect(captured.err).toContain("Run `clerk apps create` to create one.");
  });

  it("explains a workspace role without Platform API access instead of suggesting `clerk apps create`", async () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "platform_oauth_access_token_role_has_no_access",
          message: "Workspace role has no Platform API access",
          meta: {
            role: "org:support",
            roles_with_access: ["org:owner", "org:admin", "org:developer"],
          },
        },
      ],
    });
    mockListApplications.mockRejectedValue(new PlapiError(403, body));
    await ensureFirstApplication();
    expect(captured.err).toContain(
      "Could not set up a default application. Your role in this Clerk workspace (org:support) has no Platform API access",
    );
    expect(captured.err).not.toContain("clerk apps create");
  });
});
