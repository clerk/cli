import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Application } from "../../lib/plapi.ts";

const promptResult = mock();
let promptOptions:
  | { options: Array<{ value: string; disabled?: boolean }>; initialValue?: string[] }
  | undefined;

mock.module("@clack/core", () => ({
  AutocompletePrompt: class {
    constructor(options: typeof promptOptions) {
      promptOptions = options;
    }
    prompt() {
      return promptResult();
    }
  },
  isCancel: () => false,
}));

const mockSelect = mock();
mock.module("../../lib/listage.ts", () => ({
  ttyContext: () => undefined,
  select: (...a: unknown[]) => mockSelect(...a),
}));

const {
  buildInstancePickerOptions,
  developmentBranches,
  instanceLabel,
  pickInstance,
  resolveSwitchTarget,
} = await import("./shared.ts");

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

// An enabled app: the dev root is the real `main` branch, one fork hangs off it,
// and production is a separate root.
const app: Application = {
  application_id: "app_1",
  instances: [
    {
      instance_id: "ins_dev",
      environment_type: "development",
      publishable_key: "pk_dev",
      branch_name: "main",
    },
    { instance_id: "ins_prod", environment_type: "production", publishable_key: "pk_prod" },
    {
      instance_id: "ins_branch",
      environment_type: "development",
      publishable_key: "pk_b",
      branch_name: "agent/pr-42",
      parent_instance_id: "ins_dev",
      created_at: NOW - 3 * DAY,
    },
  ],
};

const devOnlyApp: Application = {
  application_id: "app_2",
  instances: [
    {
      instance_id: "ins_dev",
      environment_type: "development",
      publishable_key: "pk_dev",
      branch_name: "main",
    },
    {
      instance_id: "ins_branch",
      environment_type: "development",
      publishable_key: "pk_b",
      branch_name: "agent/pr-42",
      parent_instance_id: "ins_dev",
      created_at: NOW - 3 * DAY,
    },
  ],
};

const mainOnlyApp: Application = {
  application_id: "app_3",
  instances: [
    {
      instance_id: "ins_dev",
      environment_type: "development",
      publishable_key: "pk_dev",
      branch_name: "main",
    },
    { instance_id: "ins_prod", environment_type: "production", publishable_key: "pk_prod" },
  ],
};

describe("instanceLabel", () => {
  test("uses the branch name when present", () => {
    expect(instanceLabel(app.instances[2]!)).toBe("agent/pr-42");
  });
});

describe("developmentBranches", () => {
  test("splits main (null-parent) from its forks and excludes production", () => {
    const { main, forks } = developmentBranches(app);
    expect(main?.instance_id).toBe("ins_dev");
    expect(forks.map((f) => f.instance_id)).toEqual(["ins_branch"]);
  });
});

describe("resolveSwitchTarget", () => {
  test("resolves primary aliases, branch names, and instance IDs", () => {
    expect(resolveSwitchTarget(app, "prod").instance_id).toBe("ins_prod");
    expect(resolveSwitchTarget(app, "agent/pr-42").instance_id).toBe("ins_branch");
    expect(resolveSwitchTarget(app, "ins_dev").instance_id).toBe("ins_dev");
  });

  test("dev and main both land on the development root", () => {
    expect(resolveSwitchTarget(app, "dev").instance_id).toBe("ins_dev");
    expect(resolveSwitchTarget(app, "main").instance_id).toBe("ins_dev");
  });
});

describe("buildInstancePickerOptions", () => {
  test("pins main first with the fork nested beneath it", () => {
    expect(buildInstancePickerOptions(app, NOW).map((option) => option.label)).toEqual([
      "main",
      "agent/pr-42",
    ]);
  });

  test("renders the fork with its tree connector and age", () => {
    const branch = buildInstancePickerOptions(app, NOW)[1]!;
    expect(branch).toMatchObject({
      value: "ins_branch",
      tree: " └ ",
      created: "3d ago",
    });
    // main is the root, so it carries no tree prefix.
    expect(buildInstancePickerOptions(app, NOW)[0]!.tree).toBe("");
  });
});

describe("pickInstance (two-stage selector)", () => {
  beforeEach(() => {
    promptResult.mockReset();
    promptOptions = undefined;
    mockSelect.mockReset();
  });

  test("dev + forks: stage 1 picks the environment, stage 2 picks the branch", async () => {
    mockSelect.mockResolvedValue("development");
    promptResult.mockResolvedValue("ins_branch");

    await expect(pickInstance(app, "Switch to", "ins_dev", NOW)).resolves.toMatchObject({
      instance_id: "ins_branch",
    });
    // Stage 1 offered both environments.
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockSelect.mock.calls[0]?.[0]).toMatchObject({ message: "Select an environment:" });
    // Stage 2 opened on the current instance.
    expect(promptOptions?.initialValue).toEqual(["ins_dev"]);
  });

  test("choosing production in stage 1 resolves without a branch stage", async () => {
    mockSelect.mockResolvedValue("production");

    await expect(pickInstance(app, "Switch to", undefined, NOW)).resolves.toMatchObject({
      instance_id: "ins_prod",
    });
    // No branch stage rendered.
    expect(promptOptions).toBeUndefined();
  });

  test("no production: stage 1 is skipped, only the branch stage runs", async () => {
    promptResult.mockResolvedValue("ins_branch");

    await expect(pickInstance(devOnlyApp, "Switch to", undefined, NOW)).resolves.toMatchObject({
      instance_id: "ins_branch",
    });
    expect(mockSelect).not.toHaveBeenCalled();
    expect(promptOptions).toBeDefined();
  });

  test("main is the only branch: choosing development resolves to main immediately", async () => {
    mockSelect.mockResolvedValue("development");

    await expect(pickInstance(mainOnlyApp, "Switch to", undefined, NOW)).resolves.toMatchObject({
      instance_id: "ins_dev",
    });
    // Stage 1 ran (production exists) but stage 2 was skipped (no forks).
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(promptOptions).toBeUndefined();
  });
});
