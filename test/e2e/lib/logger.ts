const startTime = Date.now();

const isDebug = process.env.CLERK_E2E_DEBUG === "1" || process.env.CLERK_E2E_DEBUG === "true";

/** Log a timestamped message with fixture name for tracing execution order. */
export function log(message: string): void {
  if (!isDebug) return;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[e2e +${elapsed}s] ${message}`);
}
