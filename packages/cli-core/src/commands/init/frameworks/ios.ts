import type { FrameworkScaffold } from "./types.ts";

/** Public init runs the native coordinator; generic callers receive the quickstart. */
export const ios: FrameworkScaffold = {
  name: "Native Apple (Swift)",
  dep: "ios",
  matches: (ctx) => ctx.framework.dep === "ios",
  async scaffold() {
    return {
      actions: [],
      postInstructions: [
        "Run clerk init to configure the SDK, native registration, and Xcode capabilities.",
        "Quickstart: https://clerk.com/docs/ios/getting-started/quickstart",
      ],
    };
  },
};
