export interface FixtureConfig {
  /** Command run by refresh script to scaffold a fresh copy of this project. */
  scaffoldCmd: string[];
  /** Clerk SDK package name, e.g. "@clerk/nextjs" */
  clerkSdk: string;
  /** Build command run after tsc, e.g. ["next", "build"]. */
  buildCmd: string[];
  /** Dev server command, e.g. ["next", "dev"]. Port flag appended automatically. */
  devCmd: string[];
  /** Required when pinned dependency ranges explain why this variant exists. */
  notes?: string;
  /** Allowed generated dependency ranges when refreshing pinned fixtures. */
  pinnedDependencyRanges?: Record<string, string>;
  /** package.json fields to merge after scaffolding and before copying the fixture. */
  packageJsonOverrides?: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}
