import type { Selection } from "./project.ts";
import type { AndroidSdk } from "./types.ts";
import { ANDROID_QUICKSTART } from "./types.ts";

interface HandoffProgress {
  cliStatus: "not-applied" | "complete" | "incomplete" | "manual-steps-required";
  completed: { id: string; detail: string }[];
  remaining: { id: string; detail: string }[];
  changedFiles: string[];
  signInUIRequested?: boolean;
}

// Returned as command output. This is a task description, not an executed agent.
export function integrationHandoff(
  selection: Selection,
  sdk: AndroidSdk,
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
  },
) {
  const done = (id: string) => progress.completed.some((item) => item.id === id);
  const gradleTask = `./gradlew ${selection.module === "." ? "" : `:${selection.module.replaceAll("/", ":")}:`}assembleDebug`;
  return {
    schemaVersion: 1,
    kind: "clerk-android-integration",
    status:
      progress.cliStatus === "complete"
        ? done("initialize-clerk")
          ? "requires-build-and-verification"
          : "requires-source-integration"
        : "requires-cli-setup-and-source-integration",
    appIntegrationComplete: false,
    summary:
      "Read the linked documentation before completing pending Kotlin tasks, using APIs compatible with the installed SDK. Follow only sections relevant to the remaining work. Preserve completed setup and existing app behavior. Then run doctor and make one debug build. Runtime verification requires an explicit user request.",
    ...progress,
    context: {
      module: selection.module,
      namespace: selection.namespace,
      applicationId: selection.applicationId,
      sdk,
    },
    publishableKey: publishableKey ?? "<development-publishable-key>",
    tasks: [
      {
        id: "initialize-clerk",
        status: done("initialize-clerk") ? "completed" : "pending",
        instructions:
          "Initialize Clerk in the Application subclass the manifest registers: call Clerk.initialize(this, publishableKey = getString(R.string.clerk_publishable_key)) after super.onCreate(), where clerk_publishable_key is the string resource in src/main/res/values/clerk.xml holding the supplied development publishable key. Preserve custom key loading and report mismatches without adding duplicate configuration.",
        documentation: [`${ANDROID_QUICKSTART}.md`],
      },
      ...(sdk === "ui"
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
                "If sign-in UI was requested, integrate the documented Clerk UI components (AuthView and the user controls) into the existing Compose UI, driven by Clerk.isInitialized and Clerk.userFlow. Reuse existing navigation; ask about placement only when unclear. Installing clerk-android-ui alone does not authorize UI changes.",
              documentation: [`${ANDROID_QUICKSTART}.md`],
            },
          ]
        : []),
      {
        id: "build-module",
        status: "pending",
        instructions: `Run \`${gradleTask}\` from the project root with a JDK 17 or newer and the Android SDK on ANDROID_HOME. Fix integration errors you introduced and retry; report environment or unrelated build blockers and stop. Build other variants only when explicitly requested.`,
      },
      {
        id: "runtime-verification",
        status: "unverified",
        requiresUserIntent: true,
        instructions:
          "Leave runtime verification untested unless the user explicitly requests it. Do not install the app, start an emulator, automate sign-in/sign-out, or create test users as part of ordinary setup. Report sign-in as untested; this does not block completing the setup task.",
      },
    ],
    completion:
      "Stop after setup, pending source edits, doctor, and one debug build (or a reported build blocker). Report completed setup, source edits, the build result, and unresolved setup requirements. When setup and source integration are complete, 'Setup complete; sign-in not tested' is a valid outcome. appIntegrationComplete remains false because the CLI does not verify application behavior; it does not require runtime testing. Release builds and runtime tests are separate, explicitly requested work.",
  };
}
