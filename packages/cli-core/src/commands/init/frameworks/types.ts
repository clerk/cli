import type { FrameworkInfo } from "../../../lib/framework.js";

export interface ProjectContext {
  cwd: string;
  framework: FrameworkInfo;
  variant: "app-router" | "pages-router" | null;
  typescript: boolean;
  srcDir: boolean;
  packageManager: "bun" | "yarn" | "pnpm" | "npm";
  existingClerk: boolean;
  deps: Record<string, string>;
  layoutPath: string | null;
  envFile: string;
  /** Next.js middleware basename: "proxy" for Next.js 16+, "middleware" for ≤15 */
  middlewareBasename: "proxy" | "middleware";
}

export interface FileAction {
  /** Relative path from cwd */
  path: string;
  type: "create" | "modify";
  content: string;
  description: string;
  /** If set, this action is skipped and the reason is shown in the preview */
  skipReason?: string;
}

export interface ScaffoldPlan {
  actions: FileAction[];
  postInstructions: string[];
}

export interface FrameworkScaffold {
  name: string;
  scaffold(ctx: ProjectContext): Promise<ScaffoldPlan>;
}
