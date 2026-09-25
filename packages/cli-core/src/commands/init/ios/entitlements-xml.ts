import { isRecord } from "./pbx.ts";
import { parseIOSPlist } from "./plist.ts";

// Pure XML mechanics. Callers retain their limits, diagnostics and capability rules.
export function stripXMLCommentsPreservingOffsets(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, (comment) => " ".repeat(comment.length));
}

function decodeXMLText(value: string): string | undefined {
  if (/[<>]/.test(value)) return undefined;
  let unsupported = false;
  const decoded = value.replace(
    /&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/gi,
    (_entity, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
      if (named === "amp") return "&";
      if (named === "lt") return "<";
      if (named === "gt") return ">";
      if (named === "quot") return '"';
      if (named === "apos") return "'";
      unsupported = true;
      return "";
    },
  );
  if (unsupported || /&[^;\s]*;/.test(decoded)) return undefined;
  return decoded;
}

export function lineIndentAt(source: string, index: number): string {
  const start = source.lastIndexOf("\n", index - 1) + 1;
  return /^[\t ]*/.exec(source.slice(start, index))?.[0] ?? "";
}

export function bytesWithOptionalBOM(source: string, bom: boolean): Uint8Array {
  const encoded = new TextEncoder().encode(source);
  if (!bom) return encoded;
  const bytes = new Uint8Array(encoded.length + 3);
  bytes.set([0xef, 0xbb, 0xbf]);
  bytes.set(encoded, 3);
  return bytes;
}

export function literalKeyCount(source: string, key: string): number {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...stripXMLCommentsPreservingOffsets(source).matchAll(
      new RegExp(`<key\\b[^>]*>\\s*${escaped}\\s*</key>`, "g"),
    ),
  ].length;
}

export function entitlementKeyStructure(
  source: string,
  key: string,
): {
  literalCount: number;
  semanticCount: number;
  safelyDecoded: boolean;
} {
  const structural = stripXMLCommentsPreservingOffsets(source);
  let semanticCount = 0;
  let safelyDecoded = true;
  for (const match of structural.matchAll(/<key\b[^>]*>([\s\S]*?)<\/key>/g)) {
    const decoded = decodeXMLText(match[1] ?? "");
    if (decoded == null) {
      safelyDecoded = false;
      continue;
    }
    if (decoded.trim() === key) semanticCount += 1;
  }
  return { literalCount: literalKeyCount(source, key), semanticCount, safelyDecoded };
}

export function decodeEntitlementsXML(bytes: Uint8Array): {
  source: string;
  bom: boolean;
  values: Record<string, unknown>;
} {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bom ? bytes.slice(3) : bytes);
  const values = parseIOSPlist(source);
  if (!isRecord(values)) throw new Error("plist root is not a dictionary");
  return { source, bom, values };
}

export function appendEntitlementsEntry(
  source: string,
  lines: readonly string[],
): string | undefined {
  const structural = stripXMLCommentsPreservingOffsets(source);
  const dictClose = structural.lastIndexOf("</dict>");
  if (dictClose < 0) return undefined;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const closingIndent = lineIndentAt(source, dictClose);
  const insertionPoint = dictClose - closingIndent.length;
  const firstKey = /<key\b/.exec(structural);
  const childIndent =
    firstKey?.index == null ? `${closingIndent}\t` : lineIndentAt(source, firstKey.index);
  const prefix = source.slice(0, insertionPoint).endsWith("\n") ? "" : newline;
  const insertion = prefix + lines.map((line) => childIndent + line).join(newline) + newline;
  return `${source.slice(0, insertionPoint)}${insertion}${closingIndent}${source.slice(dictClose)}`;
}

export function newEntitlementsBytes(lines: readonly string[]): Uint8Array {
  return new TextEncoder().encode(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      ...lines.map((line) => "\t" + line),
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );
}
