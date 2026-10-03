import type { Selection, SetupInput } from "./plan.ts";

interface HandoffProgress {
  cliStatus: "not-applied" | "complete" | "incomplete" | "manual-steps-required";
  completed: { id: string; detail: string }[];
  remaining: { id: string; detail: string }[];
  changedFiles: string[];
  configurations: string[];
  signInUIRequested?: boolean;
  xcode?: { developerDir?: string; projectFormat: SetupInput["projectFormat"] };
}

// Returned as command output. This is a task description, not an executed agent.
export function integrationHandoff(
  selection: Selection,
  products: "core" | "ui",
  publishableKey?: string,
  progress: HandoffProgress = {
    cliStatus: "not-applied",
    completed: [],
    remaining: [
      {
        id: "cli-setup",
        detail: "This is a handoff preview. No CLI setup has been applied by this command.",
      },
    ],
    changedFiles: [],
    configurations: [selection.configuration],
  },
) {
  const done = (id: string) => progress.completed.some((item) => item.id === id);
  return {
    schemaVersion: 2,
    kind: "clerk-swift-integration",
    status:
      progress.cliStatus === "complete"
        ? done("initialize-clerk")
          ? "requires-build-and-verification"
          : "requires-source-integration"
        : "requires-cli-setup-and-source-integration",
    appIntegrationComplete: false,
    summary:
      "Read the linked documentation before completing pending Swift tasks, using APIs compatible with the installed SDK. Follow only sections relevant to the remaining work. Preserve completed setup and existing app behavior. Then run doctor and make one Debug build. Runtime verification requires an explicit user request.",
    ...progress,
    context: {
      project: selection.project,
      targetId: selection.targetId,
      targetName: selection.targetName,
      configuration: selection.configuration,
      platform: selection.sdk,
    },
    publishableKey: publishableKey ?? "<development-publishable-key>",
    tasks: [
      {
        id: "initialize-clerk",
        status: done("initialize-clerk") ? "completed" : "pending",
        instructions:
          "Initialize Clerk in the existing startup path with the supplied development publishable key. Preserve custom key loading and report mismatches without adding duplicate configuration.",
        documentation: ["https://clerk.com/docs/ios/getting-started/quickstart.md?manual=1"],
      },
      {
        id: "swiftui-environment",
        status: done("swiftui-environment") ? "completed" : "pending",
        instructions:
          "Connect Clerk to the existing SwiftUI environment and update affected previews using the linked guides. Preserve navigation, modifiers, scenes, application content, and previews. Do not introduce a ClerkProvider or wrapper view. Adapt to the existing lifecycle for UIKit apps.",
        documentation: [
          "https://clerk.com/docs/ios/getting-started/quickstart.md?manual=1",
          "https://clerk.com/docs/reference/ios/swiftui-previews.md#use-clerk-preview",
        ],
      },
      ...(products === "ui"
        ? [
            {
              id: "optional-sign-in-ui",
              requiresUserIntent: !progress.signInUIRequested && !done("optional-sign-in-ui"),
              status: done("optional-sign-in-ui")
                ? "completed"
                : progress.signInUIRequested
                  ? "pending"
                  : "requires-user-intent",
              instructions:
                "If sign-in UI was requested, integrate the documented sign-in and account controls into the existing UI. Reuse existing controls and navigation; ask about placement only when unclear. Installing ClerkKitUI alone does not authorize UI changes.",
              documentation: [
                "https://clerk.com/docs/ios/reference/views/authentication/auth-view.md",
                "https://clerk.com/docs/ios/reference/views/user/user-button.md",
              ],
            },
          ]
        : []),
      {
        id: "swift-packages",
        status: done("swift-packages") ? "completed" : "pending",
        instructions:
          "Resolve Swift packages if this step is still pending. Preserve existing version policy unless an update is authorized.",
      },
      {
        id: "build-target",
        status: "pending",
        instructions:
          "Use xcode.developerDir as DEVELOPER_DIR for one unsigned Debug build of the selected target. For iOS, use one available simulator destination with ONLY_ACTIVE_ARCH=YES; for macOS, use the current Mac. Pass CODE_SIGNING_ALLOWED=NO as a command-line override, without editing project settings. Fix integration errors you introduced and retry; report environment or unrelated build blockers and stop. If Debug is unavailable, report that. Build other configurations only when explicitly requested.",
      },
      {
        id: "runtime-verification",
        status: "unverified",
        requiresUserIntent: true,
        instructions:
          "Leave runtime verification untested unless the user explicitly requests it. Do not launch the app, automate sign-in/sign-out/relaunch, create test users, or troubleshoot simulator input as part of ordinary setup. Report signing and authentication as untested; this does not block completing the setup task.",
      },
    ],
    completion:
      "Stop after setup, pending source edits, doctor, and one Debug build (or a reported build blocker). Report completed setup, source edits, the build result, and unresolved setup requirements. When setup and source integration are complete, 'Setup complete; sign-in not tested' is a valid outcome. appIntegrationComplete remains false because the CLI does not verify application behavior; it does not require runtime testing. Release builds and runtime tests are separate, explicitly requested work.",
  };
}
