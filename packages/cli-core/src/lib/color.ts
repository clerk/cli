export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const dimNeutral = (s: string) => `\x1b[39m\x1b[2m${s}\x1b[0m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
export const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
export const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
export const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
export const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
export const blue = (s: string) => `\x1b[34m${s}\x1b[0m`;
