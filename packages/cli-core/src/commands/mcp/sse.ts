/**
 * Reassemble the `data:` payload of a single SSE event block. The SSE spec
 * allows a payload to span several `data:` lines; they join back with
 * newlines. Returns "" when the block carries no data lines.
 *
 * Kept dependency-free (used by both the `clerk mcp run` bridge and the
 * `doctor` probe) so neither drags in the other's module graph.
 */
export function sseEventData(rawEvent: string): string {
  return rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
}
