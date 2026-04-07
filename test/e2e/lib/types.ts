export interface FixtureConfig {
  description: string;
  /** Command run by refresh script to scaffold a fresh copy of this project. */
  scaffoldCmd: string[];
  /** Clerk SDK package name, e.g. "@clerk/nextjs" */
  clerkSdk: string;
  /** Build command run after tsc, e.g. ["next", "build"]. */
  buildCmd: string[];
  /** Dev server command, e.g. ["next", "dev"]. Port flag appended automatically. */
  devCmd: string[];
  /** When true, refresh script skips this fixture unless --force is passed */
  pinned: boolean;
  /** Required when pinned - explains why this variant exists */
  notes?: string;
}
