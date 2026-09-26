import { resolve } from "node:path";
import { readBoundedRegularFile } from "./bounded-file.ts";
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
    const read = await readBoundedRegularFile(absolutePath, MAX_SWIFT_FILE_BYTES);
    if (read.status !== "ok") return undefined;
    const bytes = read.bytes;
    const source = decodeUTF8(bytes);
    if (source == null || source.includes("\0")) return undefined;
    return {
      absolutePath,
      relativePath,
      bytes,
      source,
      hash: hashIOSFileBytes(bytes),
      mode: read.mode,
      device: read.device,
      inode: read.inode,
    };
  } catch {
    return undefined;
  }
}
