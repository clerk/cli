import type { PackageManager } from "../../lib/package-manager.ts";

export type BootstrapEntry = {
  label: string;
  dep: string;
  defaultProjectName: string;
  buildCommand(pm: PackageManager, projectName: string): string[];
};

const PM_RUNNERS: Record<PackageManager, string[]> = {
  npm: ["npx"],
  yarn: ["yarn", "dlx"],
  pnpm: ["pnpm", "dlx"],
  bun: ["bunx"],
};

function runner(pm: PackageManager): string[] {
  return PM_RUNNERS[pm];
}

// WARNING: All generators are pinned to @latest. This means installs are non-deterministic
// and upstream CLI changes can silently break bootstrap. If a generator changes its flags,
// update the corresponding entry here and the matching test in bootstrap.test.ts.
//
// NOTE on package-manager forwarding: Only Nuxt (--packageManager) and TanStack (--package-manager)
// accept an explicit PM flag. The others (create-next-app, create-vite, create-react-router,
// create-astro) infer the PM from npm_config_user_agent, which is set automatically when run
// via bunx/pnpm dlx/yarn dlx/npx. This works in practice since we run them via the selected
// PM's runner, and our own installDependencies() step uses the correct PM regardless.
/** Frameworks that support keyless mode — used for bootstrap (new project from empty dir / --starter). */
export const BOOTSTRAP_KEYLESS_REGISTRY: BootstrapEntry[] = [
  {
    label: "Next.js",
    dep: "next",
    defaultProjectName: "my-clerk-next-app",
    buildCommand: (pm, name) => [
      ...runner(pm),
      "create-next-app@latest",
      name,
      "--yes",
      "--skip-install",
      "--disable-git",
    ],
  },
  {
    label: "React Router",
    dep: "react-router",
    defaultProjectName: "my-clerk-react-router-app",
    buildCommand: (pm, name) => [
      ...runner(pm),
      "create-react-router@latest",
      name,
      "--yes",
      "--no-install",
      "--no-git-init",
    ],
  },
  {
    label: "Astro",
    dep: "astro",
    defaultProjectName: "my-clerk-astro-app",
    buildCommand: (pm, name) => [
      ...runner(pm),
      "create-astro@latest",
      name,
      "--yes",
      "--no-install",
      "--no-git",
      "--skip-houston",
    ],
  },
  {
    label: "Nuxt",
    dep: "nuxt",
    defaultProjectName: "my-clerk-nuxt-app",
    buildCommand: (pm, name) => [
      ...runner(pm),
      "create-nuxt@latest",
      name,
      "--template",
      "minimal",
      "--no-install",
      "--no-gitInit",
      // --no-modules suppresses the interactive modules prompt; --template minimal already
      // implies a minimal setup, but both flags are kept for belt-and-suspenders safety.
      "--no-modules",
      "--packageManager",
      pm,
    ],
  },
  {
    label: "TanStack Start",
    dep: "@tanstack/react-start",
    defaultProjectName: "my-clerk-tanstack-start-app",
    buildCommand: (pm, name) => [
      ...runner(pm),
      "@tanstack/cli@latest",
      "create",
      name,
      "--framework",
      "react",
      "--no-install",
      "--no-git",
      "--package-manager",
      pm,
    ],
  },
];

/** Frameworks that require API keys — keyless mode is not yet supported. */
export const BOOTSTRAP_AUTHENTICATED_REGISTRY: BootstrapEntry[] = [
  {
    label: "React",
    dep: "react",
    defaultProjectName: "my-clerk-react-app",
    buildCommand: (pm, name) => [
      ...runner(pm),
      "create-vite@latest",
      name,
      "--template",
      "react-ts",
    ],
  },
  {
    label: "Vue",
    dep: "vue",
    defaultProjectName: "my-clerk-vue-app",
    buildCommand: (pm, name) => [...runner(pm), "create-vite@latest", name, "--template", "vue-ts"],
  },
  {
    label: "JavaScript",
    dep: "vite",
    defaultProjectName: "my-clerk-vite-app",
    buildCommand: (pm, name) => [
      ...runner(pm),
      "create-vite@latest",
      name,
      "--template",
      "vanilla",
    ],
  },
];

/** All bootstrap-capable frameworks (keyless + authenticated). */
export const BOOTSTRAP_REGISTRY: BootstrapEntry[] = [
  ...BOOTSTRAP_KEYLESS_REGISTRY,
  ...BOOTSTRAP_AUTHENTICATED_REGISTRY,
];

export const PM_INSTALL_COMMANDS: Record<PackageManager, string[]> = {
  npm: ["npm", "install"],
  yarn: ["yarn", "install"],
  pnpm: ["pnpm", "install"],
  bun: ["bun", "install"],
};
