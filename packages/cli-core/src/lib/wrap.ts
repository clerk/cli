const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\x1b\[[0-9;]*m`, "g");

/** Columns a string occupies on screen; color escape codes don't count. */
export function visibleWidth(text: string): number {
  return text.replace(ANSI_ESCAPE_PATTERN, "").length;
}

/**
 * Word-wrap one paragraph to `width` visible columns.
 *
 * The wizard prefixes each line it prints with a gutter, and the terminal's
 * own soft wrap doesn't know about it: the wrapped remainder lands at column
 * zero and breaks the frame. So prose is wrapped here, before printing. 76
 * leaves room for the gutter on an 80-column terminal, which is what the
 * hand-wrapped text in the deploy module already assumes.
 *
 * Leading indentation and a bullet or number marker ("  - ", "  1. ") turn
 * into a hanging indent on continuation lines; `hang` overrides that for
 * lines led by a label such as "NOTE  ". A token wider than the room left,
 * such as a URL, is never split; it overflows on its own line instead.
 */
export function wrap(text: string, options: { width?: number; hang?: number } = {}): string[] {
  const width = options.width ?? 76;
  const lead = /^(\s*)((?:[-*]|\d+\.)\s+)?/.exec(text.replace(ANSI_ESCAPE_PATTERN, ""))?.[0] ?? "";
  const hang = " ".repeat(options.hang ?? lead.length);

  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  let empty = true;
  for (const word of text.split(" ")) {
    const wordWidth = visibleWidth(word);
    if (!empty && lineWidth + 1 + wordWidth > width) {
      lines.push(line.trimEnd());
      line = hang;
      lineWidth = hang.length;
      empty = true;
    }
    if (!empty) {
      line += " ";
      lineWidth += 1;
    }
    line += word;
    lineWidth += wordWidth;
    empty = false;
  }
  lines.push(line.trimEnd());
  return lines;
}
