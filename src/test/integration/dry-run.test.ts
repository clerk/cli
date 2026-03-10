/**
 * Dry-run previews before committing changes
 * Preview destructive operations safely.
 */

import { test, expect } from "bun:test";
import {
  useIntegrationTestHarness,
  installFetchMock,
  requests,
  setProfile,
  clerk,
  getInstance,
  MOCK_APP,
} from "./setup.ts";

useIntegrationTestHarness();

test.each([{ mode: "human" }, { mode: "agent" }])(
  "dry-run prevents destructive operations ($mode mode)",
  async ({ mode }) => {
    const devInstance = getInstance(MOCK_APP, "development");

    await setProfile("github.com/test/project", {
      workspaceId: "",
      appId: MOCK_APP.application_id,
      instances: { development: devInstance.instance_id },
    });

    // API dry-run: no request sent
    const { stderr: apiDryRunErr } = await clerk(
      "--mode",
      mode,
      "api",
      "/users",
      "--secret-key",
      devInstance.secret_key!,
      "-d",
      '{"email_address":["test@x.com"]}',
      "--dry-run",
    );
    expect(requests.length).toBe(0);
    expect(apiDryRunErr).toContain("[dry-run] POST");

    // Config patch dry-run: no PATCH sent
    const { stdout: patchDryRunOut, stderr: patchDryRunErr } = await clerk(
      "--mode",
      mode,
      "config",
      "patch",
      "--json",
      '{"session":{"lifetime":3600}}',
      "--dry-run",
    );
    const patchReqs = requests.filter((r) => r.method === "PATCH");
    expect(patchReqs.length).toBe(0);
    expect(patchDryRunErr).toContain("[dry-run]");
    expect(patchDryRunOut).toContain('"lifetime": 3600');

    // Same patch without dryRun -> actually sends PATCH
    const updatedConfig = { session: { lifetime: 3600 } };
    installFetchMock({ "/config": updatedConfig });

    await clerk(
      "--mode",
      mode,
      "config",
      "patch",
      "--json",
      '{"session":{"lifetime":3600}}',
      "--yes",
    );
    const realPatchReqs = requests.filter((r) => r.method === "PATCH");
    expect(realPatchReqs.length).toBeGreaterThan(0);
  },
);
