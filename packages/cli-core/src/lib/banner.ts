/**
 * Startup banner for `clerk auth login`: the Clerk mark drawn in braille,
 * beside the CLI name, version, and any non-production environment.
 *
 * The mark uses the terminal's default foreground, so it reads correctly on
 * light and dark themes without probing the background. Only the center dot
 * takes the brand purple (#6C47FF), which holds contrast on both (5.3:1 on
 * white, 3.5:1 on #131316).
 */

import { isHuman } from "../mode.ts";
import { bold, dim } from "./color.ts";
import { getCurrentEnvName } from "./environment.ts";
import { colorDisabled, isInteractive, rgbTo256, supportsTruecolor } from "./gradient.ts";
import { log } from "./log.ts";
import { CURRENT_VERSION } from "./version.ts";

// The symbol from clerk.com/brand-assets rasterized to 28x28 braille dots.
// Every row is the same width so the text column lines up.
const LOGO = [
  "⠀⠀⢀⣤⣶⣾⣿⣿⣷⣶⣤",
  "⠀⣴⣿⣿⡿⠟⠛⠛⠻⠟⠁",
  "⣸⣿⣿⠏⠀⢀⣤⣤⡀⠀⠀",
  "⣿⣿⣿⠀⠀⣿⣿⣿⣿⠀⠀",
  "⢹⣿⣿⠆⠀⠈⠛⠛⠁⠀⠀",
  "⠀⠛⠁⢀⣴⣦⣤⣤⣴⣦⡀",
  "⠀⠀⠀⠛⠿⢿⣿⣿⡿⠿⠛",
] as const;

/** Rows and columns (inclusive) of the center dot; the text sits on its rows. */
const DOT = { top: 2, bottom: 4, left: 5, right: 8 } as const;

const PURPLE: [number, number, number] = [108, 71, 255];

interface BannerOptions {
  version: string;
  /** Active environment, shown as a third line. Omitted for production. */
  environment?: string;
  color: boolean;
  truecolor: boolean;
}

export function renderBanner({ version, environment, color, truecolor }: BannerOptions): string {
  const plain = (s: string) => s;
  const strong = color ? bold : plain;
  const muted = color ? dim : plain;
  const [r, g, b] = PURPLE;
  const accent = !color
    ? plain
    : (s: string) =>
        `${truecolor ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${rgbTo256(r, g, b)}m`}${s}\x1b[39m`;

  const text = [strong("Clerk CLI"), muted(`v${version}`)];
  if (environment) text.push(muted(environment));

  const lines = LOGO.map((line, row) => {
    if (row < DOT.top || row > DOT.bottom) return line;
    const cells = [...line];
    const art =
      cells.slice(0, DOT.left).join("") +
      accent(cells.slice(DOT.left, DOT.right + 1).join("")) +
      cells.slice(DOT.right + 1).join("");
    const label = text[row - DOT.top];
    return label ? `${art}   ${label}` : art;
  });
  return `${lines.join("\n")}\n`;
}

export function shouldShowBanner(): boolean {
  if (!isHuman()) return false;
  if (!isInteractive()) return false;
  if (process.env.CLERK_NO_BANNER) return false;
  return true;
}

export function printBanner(): void {
  if (!shouldShowBanner()) return;
  const env = getCurrentEnvName();
  log.ui(
    renderBanner({
      version: CURRENT_VERSION,
      environment: env === "production" ? undefined : env,
      color: !colorDisabled(),
      truecolor: supportsTruecolor(),
    }),
  );
  log.blank();
}
