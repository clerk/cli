// Color emission is gated on stdout TTY detection, the NO_COLOR env var
// (https://no-color.org), and the runtime override `setColorEnabled(false)`
// — driven by the global `--no-color` flag.
let enabled: boolean = process.stdout.isTTY === true && !process.env.NO_COLOR;

export function setColorEnabled(value: boolean) {
  enabled = value;
}

export function isColorEnabled(): boolean {
  return enabled;
}

const wrap = (open: string) => (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[0m` : s);

export const dim = wrap("2");
export const dimNeutral = (s: string) => (enabled ? `\x1b[39m\x1b[2m${s}\x1b[0m` : s);
export const bold = wrap("1");
export const cyan = wrap("36");
export const green = wrap("32");
export const yellow = wrap("33");
export const red = wrap("31");
export const blue = wrap("34");
