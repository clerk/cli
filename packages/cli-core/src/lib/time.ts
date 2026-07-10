/**
 * Format a past timestamp as a short, human-readable relative age (e.g. "5m ago",
 * "3d ago"). `now` is injected so callers can render deterministic output in tests.
 * Future or equal timestamps clamp to "just now".
 */
export function formatRelativeTime(from: number, now: number): string {
  const diffMs = Math.max(0, now - from);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  const yr = Math.floor(mon / 12);
  return `${yr}y ago`;
}
