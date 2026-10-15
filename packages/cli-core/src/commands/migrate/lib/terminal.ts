import fs from "node:fs";

/**
 * Whether a prompt has a terminal to read: stdin, or `/dev/tty` behind a piped
 * stdin. `CLERK_MODE=human` forces human mode without one, and a prompt with
 * no terminal fails to open it and spins. An object so tests can swap it.
 */
export const terminal = {
  available(): boolean {
    if (process.stdin.isTTY) return true;
    try {
      fs.closeSync(fs.openSync(process.platform === "win32" ? "CONIN$" : "/dev/tty", "r"));
      return true;
    } catch {
      return false;
    }
  },
};
