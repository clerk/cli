/**
 * ProjectDetector collaborator (stub).
 *
 * In the foundation PR, this is a thin wrapper around the existing
 * `gatherContext` from `commands/init/context.ts`. The full migration
 * (PR 8 in the deps-injection migration plan) moves the entire detection
 * implementation into `lib/project-detector/`, including the framework
 * enrichers and the I/O parts of `lib/framework.ts`. For now, this stub
 * exists so the DepsRegistry shape is stable from PR 0.
 */

import { gatherContext } from "../commands/init/context.ts";
import type { ProjectContext } from "../commands/init/frameworks/types.ts";
import type { FrameworkInfo } from "./framework.ts";

export interface ProjectDetector {
  gather(cwd: string, override?: FrameworkInfo): Promise<ProjectContext | null>;
}

export const projectDetector: ProjectDetector = {
  gather: (cwd, override) => gatherContext(cwd, override),
};
