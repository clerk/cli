/**
 * Apple treats Bundle IDs as case-insensitive, while Clerk matches native
 * registrations exactly. Use this to spot a registration that differs only in
 * letter case; keep the original spelling for display and API writes.
 */
export function bundleIdentifiersEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
