import type { FixtureConfig } from "./lib/types.ts";

/**
 * Single source of truth for every E2E fixture. Both the test files and
 * `scripts/refresh-e2e-fixtures.ts` read from this manifest, so the manifest
 * keys double as the fixture directory names (`test/e2e/fixtures/<name>/`)
 * and as the typed argument to `createFixtureHarness()`.
 *
 * Adding a fixture: add an entry below and create the matching
 * `test/e2e/<name>.test.ts` calling `createFixtureHarness("<name>")`.
 */
export const fixtures = {
  astro: {
    scaffoldCmd: [
      "npx",
      "--yes",
      "create-astro@latest",
      ".",
      "--template",
      "minimal",
      "--typescript",
      "strict",
      "--no-install",
      "--yes",
    ],
    clerkSdk: "@clerk/astro",
    buildCmd: ["astro", "build"],
    devCmd: ["astro", "dev"],
  },
  "nextjs-app-router": {
    scaffoldCmd: [
      "npx",
      "--yes",
      "create-next-app@latest",
      ".",
      "--ts",
      "--app",
      "--no-tailwind",
      "--no-eslint",
      "--use-npm",
      "--skip-install",
      "--yes",
    ],
    clerkSdk: "@clerk/nextjs",
    buildCmd: ["next", "build"],
    devCmd: ["next", "dev"],
  },
  "nextjs-app-router-next14": {
    scaffoldCmd: [
      "env",
      "CI=1",
      "npx",
      "--yes",
      "create-next-app@14",
      ".",
      "--ts",
      "--app",
      "--no-tailwind",
      "--no-eslint",
      "--use-npm",
    ],
    clerkSdk: "@clerk/nextjs",
    buildCmd: ["next", "build"],
    devCmd: ["next", "dev"],
    pinnedDependencyRanges: {
      next: "^14",
    },
    notes:
      "Next.js <16 uses middleware.ts; >=16 uses proxy.ts. This fixture tests the version-aware middleware basename logic in src/commands/init/context.ts.",
  },
  "nextjs-pages-router": {
    scaffoldCmd: [
      "npx",
      "--yes",
      "create-next-app@latest",
      ".",
      "--ts",
      "--no-app",
      "--no-tailwind",
      "--no-eslint",
      "--use-npm",
      "--skip-install",
      "--yes",
    ],
    clerkSdk: "@clerk/nextjs",
    buildCmd: ["next", "build"],
    devCmd: ["next", "dev"],
  },
  nuxt: {
    scaffoldCmd: [
      "npx",
      "--yes",
      "nuxi@latest",
      "init",
      ".",
      "--template",
      "minimal",
      "--no-install",
      "--no-gitInit",
      "--packageManager",
      "npm",
      "--force",
    ],
    clerkSdk: "@clerk/nuxt",
    buildCmd: ["nuxt", "build"],
    devCmd: ["nuxt", "dev"],
  },
  react: {
    scaffoldCmd: ["npx", "--yes", "create-vite@latest", ".", "--template", "react-ts"],
    clerkSdk: "@clerk/react",
    buildCmd: ["vite", "build"],
    devCmd: ["vite"],
  },
  "react-router": {
    scaffoldCmd: [
      "npx",
      "--yes",
      "create-react-router@latest",
      ".",
      "--package-manager",
      "npm",
      "--no-install",
      "--no-git-init",
      "--yes",
    ],
    clerkSdk: "@clerk/react-router",
    buildCmd: ["react-router", "build"],
    devCmd: ["react-router", "dev"],
    packageJsonOverrides: {
      dependencies: {
        "@react-router/node": "7.15.0",
        "@react-router/serve": "7.15.0",
        "react-router": "7.15.0",
      },
      devDependencies: {
        "@react-router/dev": "7.15.0",
      },
    },
  },
  "tanstack-start": {
    scaffoldCmd: [
      "npx",
      "--yes",
      "@tanstack/cli@latest",
      "create",
      "myapp",
      "--target-dir",
      ".",
      "--no-install",
      "--package-manager",
      "npm",
      "--no-git",
      "--no-toolchain",
      "--no-examples",
      "--force",
    ],
    clerkSdk: "@clerk/tanstack-react-start",
    buildCmd: ["vite", "build"],
    devCmd: ["vite", "dev"],
    packageJsonOverrides: {
      devDependencies: {
        // TanStack Start's current scaffold omits this peer dependency even
        // though the Vite plugin imports it during config evaluation.
        "@rsbuild/core": "^2.0.0",
      },
    },
  },
  vue: {
    scaffoldCmd: ["npx", "--yes", "create-vite@latest", ".", "--template", "vue-ts"],
    clerkSdk: "@clerk/vue",
    buildCmd: ["vite", "build"],
    devCmd: ["vite"],
  },
} as const satisfies Record<string, FixtureConfig>;

export type FixtureName = keyof typeof fixtures;
