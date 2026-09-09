export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const dimNeutral = (s: string) => `\x1b[39m\x1b[2m${s}\x1b[0m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
export const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
export const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
export const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
export const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
export const blue = (s: string) => `\x1b[34m${s}\x1b[0m`;
/** Removes the SGR escape sequences the helpers above add, for machine-readable output. */
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
export const stripAnsi = (s: string) => s.replace(ANSI_SGR, "");
