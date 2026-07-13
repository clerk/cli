import { test, expect, describe } from "bun:test";
import { buildInstancePickerChoices } from "./instance-choices.ts";
import type { ApplicationInstance } from "../../../lib/plapi.ts";

const NOW = 1_000_000_000_000;
const sec = 1000;
const min = 60 * sec;
const hr = 60 * min;
const day = 24 * hr;

const inst = (
  over: Partial<ApplicationInstance> & { instance_id: string },
): ApplicationInstance => ({
  environment_type: "development",
  publishable_key: "pk",
  ...over,
});

describe("buildInstancePickerChoices", () => {
  test("labels roots by env and nests branches under their parent", () => {
    const instances = [
      inst({ instance_id: "ins_dev", environment_type: "development", created_at: NOW - 3 * day }),
      inst({ instance_id: "ins_prod", environment_type: "production", created_at: NOW - 8 * day }),
      inst({
        instance_id: "ins_b1",
        branch_name: "feature-checkout",
        parent_instance_id: "ins_dev",
        created_at: NOW - 2 * hr,
      }),
      inst({
        instance_id: "ins_b2",
        branch_name: "agent/pr-42",
        parent_instance_id: "ins_dev",
        created_at: NOW - 1 * hr,
      }),
    ];
    const choices = buildInstancePickerChoices(instances, NOW);

    // Order: development, its branches (created asc), production.
    expect(choices.map((c) => c.value)).toEqual(["ins_dev", "ins_b1", "ins_b2", "ins_prod"]);
    expect(choices[0]!.name).toContain("development");
    expect(choices[0]!.name).toContain("ins_dev");
    expect(choices[0]!.name).toContain("3d ago");
    // Branches carry the env-qualified glyph label (ADR-0007): first child uses
    // ├─, last child uses └─.
    expect(choices[1]!.name).toContain("├─ development ⎇ feature-checkout");
    expect(choices[2]!.name).toContain("└─ development ⎇ agent/pr-42");
    expect(choices[3]!.name).toContain("production");
  });

  test("orphan branch (unknown parent) renders as a root row", () => {
    const instances = [
      inst({
        instance_id: "ins_b",
        branch_name: "lonely",
        parent_instance_id: "ins_missing",
        created_at: NOW - hr,
      }),
    ];
    const choices = buildInstancePickerChoices(instances, NOW);
    expect(choices).toHaveLength(1);
    expect(choices[0]!.value).toBe("ins_b");
    expect(choices[0]!.name).toContain("lonely");
    expect(choices[0]!.name).not.toContain("├─");
    expect(choices[0]!.name).not.toContain("└─");
  });

  test("branch-of-a-branch indents a further level", () => {
    const instances = [
      inst({ instance_id: "ins_dev", environment_type: "development", created_at: NOW - 3 * day }),
      inst({
        instance_id: "ins_b1",
        branch_name: "pr-1",
        parent_instance_id: "ins_dev",
        created_at: NOW - 2 * hr,
      }),
      inst({
        instance_id: "ins_b2",
        branch_name: "pr-1-a",
        parent_instance_id: "ins_b1",
        created_at: NOW - hr,
      }),
    ];
    const choices = buildInstancePickerChoices(instances, NOW);
    expect(choices.map((c) => c.value)).toEqual(["ins_dev", "ins_b1", "ins_b2"]);
    // Deeper nesting carries the continuation indent before the connector.
    expect(choices[2]!.name).toContain("   └─ development ⎇ pr-1-a");
  });
});
