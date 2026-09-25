import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathIsSafelyWithinIOSRoot } from "./discovery.ts";
import { hashIOSFileBytes } from "./file-transaction.ts";

const MAX_SWIFT_FILE_BYTES = 1_000_000;

export interface IOSSourceSnapshot {
  absolutePath: string;
  relativePath: string;
  bytes: Uint8Array;
  source: string;
  hash: string;
  mode: number;
  device: number;
  inode: number;
}

export function newlineStyle(source: string): "\n" | "\r\n" | undefined {
  if (/\r(?!\n)/.test(source)) return undefined;
  const hasCRLF = source.includes("\r\n");
  const hasBareLF = /(^|[^\r])\n/.test(source);
  if (hasCRLF && hasBareLF) return undefined;
  return hasCRLF ? "\r\n" : "\n";
}

function decodeUTF8(bytes: Uint8Array): string | undefined {
  try {
    // ignoreBOM retains a leading U+FEFF so re-encoding preserves exact bytes.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export async function readIOSSourceSnapshot(
  root: string,
  relativePath: string,
): Promise<IOSSourceSnapshot | undefined> {
  const absolutePath = resolve(root, relativePath);
  if (!(await pathIsSafelyWithinIOSRoot(root, absolutePath))) return undefined;
  try {
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SWIFT_FILE_BYTES) {
      return undefined;
    }
    const bytes = new Uint8Array(await readFile(absolutePath));
    const source = decodeUTF8(bytes);
    if (source == null || source.includes("\0")) return undefined;
    return {
      absolutePath,
      relativePath,
      bytes,
      source,
      hash: hashIOSFileBytes(bytes),
      mode: info.mode & 0o7777,
      device: info.dev,
      inode: info.ino,
    };
  } catch {
    return undefined;
  }
}
