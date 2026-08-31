import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectIOSProject } from "./inspect.ts";
import { buildIOSLocalSetupProposal, createIOSLocalSetupContext } from "./local-plan.ts";
import { applyIOSLocalSetup, applyIOSPlannedLocalSetup } from "./apply.ts";
import { createIOSFixture, treeDigest } from "./test-helpers.ts";
import { createIOSDryRunOutput } from "./output.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";

const temporaryDirectories: string[] = [];
const publishableKey = `pk_test_${Buffer.from("local-plan.clerk.example$").toString("base64")}`;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("iOS local setup lifecycle", () => {
  useCaptureLog();

  test("does not ask about Apple after an explicitly requested AuthView plan is blocked", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-local-plan-blocked-auth-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true, includeKey: false });
    const inspection = await inspectIOSProject(root, {
      target: "MyApp",
      exhaustiveContainerDiscovery: true,
    });
    let applePromptCount = 0;

    const proposal = await buildIOSLocalSetupProposal(createIOSLocalSetupContext(inspection), {
      root,
      allowDirty: true,
      prebuiltAuthUI: true,
      resolveNativeAppleRequest: async () => {
        applePromptCount += 1;
        return true;
      },
    });

    expect(proposal.inspectedPrebuiltAuthPlan?.status).toBe("blocked");
    expect(applePromptCount).toBe(0);
    expect(proposal.nativeAppleRequested).toBe(false);
  });

  test("uses the same read-only proposal for preview and apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-local-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { clerkSDK: false, includeKey: false });
    const initialBytes = await treeDigest(root);

    const inspection = await inspectIOSProject(root, {
      target: "MyApp",
      exhaustiveContainerDiscovery: true,
    });
    const proposal = await buildIOSLocalSetupProposal(createIOSLocalSetupContext(inspection), {
      root,
      allowDirty: true,
      prebuiltAuthUI: false,
      signInWithApple: false,
    });

    expect(await treeDigest(root)).toEqual(initialBytes);
    const dryRun = createIOSDryRunOutput(proposal.inspection, proposal.setupPlan, {
      associatedDomainPlan: proposal.plannedAssociatedDomain,
      nativeReadiness: proposal.nativeReadiness,
    });
    expect(dryRun.plan).toBe(proposal.setupPlan);
    expect(dryRun.nativeReadiness).toBe(proposal.nativeReadiness);
    expect(
      proposal.setupPlan.steps
        .filter((step) => step.status === "required" && step.automatable)
        .map((step) => step.id),
    ).toEqual(
      expect.arrayContaining([
        "install-clerk-sdk",
        "configure-publishable-key",
        "inject-clerk-environment",
        "add-associated-domain",
      ]),
    );

    const approved = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: false,
      allowDirty: true,
      prebuiltAuthUI: false,
      signInWithApple: false,
    });
    expect(approved.setupPlan).toEqual(proposal.setupPlan);
    expect(await treeDigest(root)).toEqual(initialBytes);

    await applyIOSPlannedLocalSetup(approved, publishableKey);
    const appliedBytes = await treeDigest(root);
    expect(appliedBytes).not.toEqual(initialBytes);

    const rerun = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: false,
      allowDirty: true,
      prebuiltAuthUI: false,
      signInWithApple: false,
    });
    await applyIOSPlannedLocalSetup(rerun, publishableKey);
    expect(await treeDigest(root)).toEqual(appliedBytes);
  });
});
