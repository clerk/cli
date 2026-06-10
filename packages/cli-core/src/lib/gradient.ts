import { log } from "./log.ts";

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  const toByte = (v: number) => Math.round((v + m) * 255);
  return [toByte(r), toByte(g), toByte(b)];
}

export function rgbTo256(r: number, g: number, b: number): number {
  const channel = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * channel(r) + 6 * channel(g) + channel(b);
}

const BASE = { hue: 314, sat: 0.3, light: 0.63 };
const SHINE = { peakLight: 0.95, peakSat: 0.06, halfWidth: 0.3 };

interface ShineOptions {
  center?: number;
  truecolor?: boolean;
  hue?: number;
  sat?: number;
  light?: number;
}

function fgEscape(hue: number, sat: number, light: number, truecolor: boolean): string {
  const [r, g, b] = hslToRgb(hue, sat, light);
  return truecolor ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${rgbTo256(r, g, b)}m`;
}

export function shineText(text: string, options: ShineOptions = {}): string {
  const {
    center,
    truecolor = supportsTruecolor(),
    hue = BASE.hue,
    sat = BASE.sat,
    light = BASE.light,
  } = options;

  const chars = [...text];
  const denom = Math.max(1, chars.length - 1);
  let out = "";
  let opened = false;
  chars.forEach((ch, i) => {
    if (ch === " ") {
      if (opened) {
        out += "\x1b[39m";
        opened = false;
      }
      out += ch;
      return;
    }
    let s = sat;
    let l = light;
    if (center != null) {
      const distance = Math.abs(i / denom - center);
      const falloff = Math.max(0, 1 - distance / SHINE.halfWidth);
      const intensity = falloff * falloff;
      l = light + (SHINE.peakLight - light) * intensity;
      s = sat + (SHINE.peakSat - sat) * intensity;
    }
    out += fgEscape(hue, s, l, truecolor) + ch;
    opened = true;
  });
  return opened ? out + "\x1b[39m" : out;
}

const isInteractive = () => !!process.stderr.isTTY && !process.env.CI;

const forceColor = () => {
  const v = process.env.FORCE_COLOR;
  return v != null && v !== "0" && v !== "false" && v !== "";
};

const colorDisabled = () => "NO_COLOR" in process.env && !forceColor();

const supportsTruecolor = () => /truecolor|24bit/i.test(process.env.COLORTERM ?? "");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let cursorHidden = false;
let exitGuardRegistered = false;

function hideCursor(): void {
  if (!exitGuardRegistered) {
    process.on("exit", () => {
      if (cursorHidden) log.ui("\x1b[?25h");
    });
    exitGuardRegistered = true;
  }
  cursorHidden = true;
  log.ui("\x1b[?25l");
}

function showCursor(): void {
  cursorHidden = false;
  log.ui("\x1b[?25h");
}

interface AnimateHeaderOptions {
  prefix: string;
  label: string;
  fallback: (s: string) => string;
  frames?: number;
  intervalMs?: number;
  write?: (s: string) => void;
}

export async function animateHeader(options: AnimateHeaderOptions): Promise<void> {
  const { prefix, label, fallback, frames = 18, intervalMs = 25, write = log.ui } = options;

  if (!isInteractive() || colorDisabled()) {
    write(`${prefix}${fallback(label)}\n`);
    return;
  }

  const truecolor = supportsTruecolor();
  const span = Math.max(1, frames - 1);
  hideCursor();
  try {
    for (let frame = 0; frame < frames; frame++) {
      const center = -0.3 + (frame / span) * 1.6;
      write(`\r\x1b[K${prefix}${shineText(label, { center, truecolor })}`);
      await sleep(intervalMs);
    }
    write(`\r\x1b[K${prefix}${shineText(label, { truecolor })}\n`);
  } finally {
    showCursor();
  }
}
