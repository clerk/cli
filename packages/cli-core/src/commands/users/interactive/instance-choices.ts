/**
 * Pure rendering helpers for the interactive instance picker. Kept separate
 * from instance-context.ts so the tree/label formatting is unit-testable
 * without driving the prompt.
 */

import type { ApplicationInstance } from "../../../lib/plapi.ts";
import { formatRelativeTime } from "../../../lib/time.ts";

type PickerChoice = { value: string; name: string };

type Row = { value: string; name: string; created: number };

/**
 * Render instances into native `select` option labels. Non-branch instances are
 * roots labeled by environment_type; branches nest under the parent they were
 * forked from using box-drawing connectors. Each label is padded into three
 * columns: name, instance id, relative created-at. `now` is injected so the
 * output is deterministic for tests.
 */
export function buildInstancePickerChoices(
  instances: ApplicationInstance[],
  now: number,
): PickerChoice[] {
  const known = new Set(instances.map((i) => i.instance_id));
  const childrenOf = new Map<string, ApplicationInstance[]>();
  for (const i of instances) {
    if (i.branch_name && i.parent_instance_id && known.has(i.parent_instance_id)) {
      const list = childrenOf.get(i.parent_instance_id) ?? [];
      list.push(i);
      childrenOf.set(i.parent_instance_id, list);
    }
  }

  const isRoot = (i: ApplicationInstance) =>
    !i.branch_name || !i.parent_instance_id || !known.has(i.parent_instance_id);

  const envRank = (t: string) => (t === "development" ? 0 : t === "production" ? 1 : 2);
  const roots = instances
    .filter(isRoot)
    .sort(
      (a, b) =>
        envRank(a.environment_type) - envRank(b.environment_type) ||
        (a.created_at ?? 0) - (b.created_at ?? 0),
    );

  const rows: Row[] = [];
  const visit = (i: ApplicationInstance, root: boolean, indent: string, last: boolean) => {
    const connector = root ? "" : `${indent}${last ? "└─ " : "├─ "}`;
    const label = i.branch_name ?? i.environment_type;
    rows.push({ value: i.instance_id, name: `${connector}${label}`, created: i.created_at ?? 0 });
    const kids = (childrenOf.get(i.instance_id) ?? []).sort(
      (a, b) => (a.created_at ?? 0) - (b.created_at ?? 0),
    );
    const childIndent = root ? "  " : `${indent}${last ? "   " : "│  "}`;
    kids.forEach((kid, idx) => visit(kid, false, childIndent, idx === kids.length - 1));
  };
  roots.forEach((root) => visit(root, true, "", true));

  if (rows.length === 0) return [];

  const nameWidth = Math.max(...rows.map((r) => r.name.length));
  const idWidth = Math.max(...rows.map((r) => r.value.length));
  return rows.map((r) => ({
    value: r.value,
    name: `${r.name.padEnd(nameWidth)}  ${r.value.padEnd(idWidth)}  ${formatRelativeTime(r.created, now)}`,
  }));
}
