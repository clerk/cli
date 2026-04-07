import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pull } from "./pull.ts";
import { testRoot } from "../../test/lib/test-root.ts";

/**
 * `pull` is now a thin wrapper around `pullDefault`. The full coverage matrix
 * lives in `helpers/pull-default.test.ts`. This file just verifies the public
 * command delegates correctly so init/CLI wiring stays honest.
 */
describe("env pull", () => {
  const originalCwd = process.cwd;
  let tempDir: string;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-env-pull-cmd-test-"));
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { express: "4.0.0" } }),
    );
    process.cwd = () => tempDir;
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    errorSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("delegates to pullDefault and writes keys", async () => {
    const deps = testRoot({
      configStore: {
        resolveAppContext: async () => ({
          appId: "app_1",
          appLabel: "app_1",
          instanceId: "ins_dev",
          instanceLabel: "development",
        }),
      },
      plapi: {
        fetchApplication: async () => ({
          application_id: "app_1",
          instances: [
            {
              instance_id: "ins_dev",
              environment_type: "development",
              publishable_key: "pk_test_abc123",
              secret_key: "sk_test_xyz789",
            },
          ],
        }),
      },
    });

    await pull(deps);

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("CLERK_PUBLISHABLE_KEY=pk_test_abc123");
    expect(content).toContain("CLERK_SECRET_KEY=sk_test_xyz789");
  });

  test("propagates options to pullDefault", async () => {
    const deps = testRoot({
      configStore: {
        resolveAppContext: async () => ({
          appId: "app_1",
          appLabel: "app_1",
          instanceId: "ins_prod",
          instanceLabel: "production",
        }),
      },
      plapi: {
        fetchApplication: async () => ({
          application_id: "app_1",
          instances: [
            {
              instance_id: "ins_prod",
              environment_type: "production",
              publishable_key: "pk_live_abc123",
              secret_key: "sk_live_xyz789",
            },
          ],
        }),
      },
    });

    await pull(deps, { instance: "prod", file: ".env.production" });

    const content = await Bun.file(join(tempDir, ".env.production")).text();
    expect(content).toContain("CLERK_PUBLISHABLE_KEY=pk_live_abc123");
    expect(deps.configStore.resolveAppContext).toHaveBeenCalledWith({
      instance: "prod",
      file: ".env.production",
    });
  });
});
