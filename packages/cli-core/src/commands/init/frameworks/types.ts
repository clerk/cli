import type { FrameworkInfo } from "../../../lib/framework.js";

export interface ProjectContext {
  cwd: string;
  framework: FrameworkInfo;
  typescript: boolean;
  srcDir: boolean;
  packageManager: "bun" | "yarn" | "pnpm" | "npm";
  existingClerk: boolean;
  deps: Record<string, string>;
  envFile: string;
  /** Framework-specific variant (e.g., "app-router" | "pages-router"). Populated by enrichContext. */
  variant?: "app-router" | "pages-router" | null;
  /** Path to the layout/entry file. Populated by enrichContext. */
  layoutPath?: string | null;
  /** Next.js middleware basename: "proxy" for Next.js 16+, "middleware" for ≤15. Populated by enrichContext. */
  middlewareBasename?: "proxy" | "middleware";
  /** i18n locale directory segment (e.g., "[locale]"). Set by enrichContext when detected. */
  i18nLocaleDir?: string;
}

export type FileAction =
  | { type: "create"; path: string; content: string; description: string }
  | { type: "modify"; path: string; content: string; description: string }
  | { type: "skip"; path: string; skipReason: string };

export interface ScaffoldPlan {
  actions: FileAction[];
  postInstructions: string[];
}

export interface FrameworkScaffold {
  name: string;
  /** The npm dependency name this scaffolder targets (e.g., "next", "react", "astro"). */
  dep: string;
  /** Optional variant label (e.g., "app-router", "pages-router"). */
  variant?: string;
  /** Minimum major version of the framework dependency required for scaffolding. */
  minMajorVersion?: number;
  /** Return true if this scaffolder handles the given project context. */
  matches(ctx: ProjectContext): boolean;
  /** Populate framework-specific fields on the context before scaffolding. */
  enrichContext?(ctx: ProjectContext): Promise<void>;
  scaffold(ctx: ProjectContext): Promise<ScaffoldPlan>;
}
