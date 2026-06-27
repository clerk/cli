const startTime = Date.now();

const isDebug = process.env.CLERK_E2E_DEBUG === "1" || process.env.CLERK_E2E_DEBUG === "true";

/** Emit a timestamped diagnostic line when CLERK_E2E_DEBUG is set. */
export function log(message: string): void {
  if (!isDebug) return;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[e2e +${elapsed}s] ${message}`);
}
