import { join } from "node:path";
import type { FixtureConfig } from "./lib/types.ts";

/**
 * Express and Fastify have no official scaffolder, so their fixtures come from
 * hand-authored templates checked in under `test/e2e/templates/<name>/`. The
 * scaffoldCmd copies the template; the refresh script then resolves the
 * template's `latest` dependency specs to exact pins and generates the
 * lockfile, exactly as it does for scaffolder-generated fixtures.
 */
const TEMPLATES_DIR = join(import.meta.dir, "templates");

function copyTemplateCmd(name: string): string[] {
  return ["cp", "-R", `${join(TEMPLATES_DIR, name)}/.`, "."];
}

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
  expo: {
    scaffoldCmd: ["npx", "--yes", "create-expo-app@latest", ".", "--no-install"],
    clerkSdk: "@clerk/expo",
    // Web export is the only build that runs headless in CI — native builds
    // need Xcode/Gradle toolchains. It still bundles the ClerkProvider-wrapped
    // layout through Metro, so a broken scaffold fails the build.
    buildCmd: ["expo", "export", "--platform", "web"],
    // Unused: no browser test for Expo (see expo.test.ts), but the manifest
    // shape requires a dev command.
    devCmd: ["expo", "start", "--web"],
    packageJsonOverrides: {
      dependencies: {
        // Required at bundle time by @clerk/expo/token-cache, which the
        // scaffolded layout imports. `clerk init` tells users to run
        // `npx expo install expo-secure-store`; the fixture pre-installs it
        // (which also keeps that post-instruction out of the init output).
        "expo-secure-store": "latest",
      },
    },
  },
  express: {
    scaffoldCmd: copyTemplateCmd("express"),
    clerkSdk: "@clerk/express",
    // No build step for a plain Node server — tsc doubles as the "build".
    buildCmd: ["tsc", "--noEmit"],
    // Node >= 23 strips types natively; the template parses --port/--host.
    // --experimental-strip-types: default-on since Node 23.6, but the explicit
    // flag keeps the fixture running on Node >= 22.6 too.
    devCmd: ["node", "--experimental-strip-types", "--env-file=.env.local", "index.ts"],
  },
  fastify: {
    scaffoldCmd: copyTemplateCmd("fastify"),
    clerkSdk: "@clerk/fastify",
    buildCmd: ["tsc", "--noEmit"],
    // --experimental-strip-types: default-on since Node 23.6, but the explicit
    // flag keeps the fixture running on Node >= 22.6 too.
    devCmd: ["node", "--experimental-strip-types", "--env-file=.env.local", "index.ts"],
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
    // create-react-router scaffolds v8, but the fixture stays on v7 so the
    // `v8_middleware` config path in the React Router scaffolder keeps its
    // e2e coverage (see shouldEnableV8MiddlewareFlag). Keep this at the
    // latest 7.x: 7.18.2 is the first release clearing GHSA-chx6-hx7r-mcp5
    // and GHSA-qwww-vcr4-c8h2, and @clerk/react-router peers ^7.9.0 || ^8.3.0.
    packageJsonOverrides: {
      dependencies: {
        "@react-router/node": "7.18.2",
        "@react-router/serve": "7.18.2",
        "react-router": "7.18.2",
      },
      devDependencies: {
        "@react-router/dev": "7.18.2",
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
