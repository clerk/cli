import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Application } from "../../lib/plapi.ts";

const promptResult = mock();
let promptOptions:
  | { options: Array<{ value: string; disabled: boolean }>; initialValue?: string[] }
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

mock.module("../../lib/listage.ts", () => ({ ttyContext: () => undefined }));

const { buildInstancePickerOptions, instanceLabel, pickInstance, resolveSwitchTarget } =
  await import("./shared.ts");

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
const app: Application = {
  application_id: "app_1",
  instances: [
    { instance_id: "ins_dev", environment_type: "development", publishable_key: "pk_dev" },
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

describe("instanceLabel", () => {
  test("uses the branch name when present", () => {
    expect(instanceLabel(app.instances[2]!)).toBe("agent/pr-42");
  });
});

describe("resolveSwitchTarget", () => {
  test("resolves primary aliases, branch names, and instance IDs", () => {
    expect(resolveSwitchTarget(app, "prod").instance_id).toBe("ins_prod");
    expect(resolveSwitchTarget(app, "agent/pr-42").instance_id).toBe("ins_branch");
    expect(resolveSwitchTarget(app, "ins_dev").instance_id).toBe("ins_dev");
  });
});

describe("buildInstancePickerOptions", () => {
  test("keeps both roots selectable and groups the branch under Development", () => {
    // The branch forks development, so it renders beneath the Development root
    // and above the Production root.
    expect(buildInstancePickerOptions(app, NOW).map((option) => option.label)).toEqual([
      "Development",
      "Development ⎇ agent/pr-42",
      "Production",
    ]);
  });

  test("associates the branch with the development environment", () => {
    const branch = buildInstancePickerOptions(app, NOW)[1]!;
    expect(branch).toMatchObject({
      environment: "development",
      kind: "branch",
      tree: " └ ",
      created: "3d ago",
    });
  });
});

describe("pickInstance", () => {
  beforeEach(() => {
    promptResult.mockReset();
    promptOptions = undefined;
  });

  test("returns the selected instance and opens on the current instance", async () => {
    promptResult.mockResolvedValue("ins_branch");

    await expect(pickInstance(app, "Choose an instance", "ins_dev", NOW)).resolves.toMatchObject({
      instance_id: "ins_branch",
    });
    expect(promptOptions?.initialValue).toEqual(["ins_dev"]);
  });
});
