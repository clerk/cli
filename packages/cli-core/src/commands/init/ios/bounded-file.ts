import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

const READ_CHUNK_BYTES = 64 * 1024;

export type BoundedRegularFileReadResult =
  | { status: "ok"; bytes: Uint8Array }
  | { status: "missing" | "not-regular" | "too-large" | "unreadable" };

function missingPath(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

/**
 * Reads a regular file without letting special files block the process or a
 * concurrently growing file exceed the caller's memory bound. Type, size,
 * and bytes all come from the same descriptor so a replacement at the path
 * cannot invalidate the checks performed before the read.
 */
export async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
): Promise<BoundedRegularFileReadResult> {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    return { status: missingPath(error) ? "missing" : "unreadable" };
  }

  try {
    const info = await handle.stat();
    if (!info.isFile()) return { status: "not-regular" };
    if (info.size > maxBytes) return { status: "too-large" };

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const bytesUntilOverflow = maxBytes - totalBytes + 1;
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, bytesUntilOverflow));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, totalBytes);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) return { status: "too-large" };
      chunks.push(chunk.subarray(0, bytesRead));
    }

    return { status: "ok", bytes: Buffer.concat(chunks, totalBytes) };
  } catch {
    return { status: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
