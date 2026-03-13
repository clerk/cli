export interface Target {
  name: string;
  os: string;
  cpu: string;
  libc?: string;
}

// Target names use Node.js ${process.platform}-${process.arch} convention so the wrapper
// shim (packages/cli/bin/clerk) can derive package names without a lookup table.
// Keep in sync with .github/workflows/build-binaries.yml matrix.
export const targets: Target[] = [
  { name: "darwin-arm64", os: "darwin", cpu: "arm64" },
  { name: "darwin-x64", os: "darwin", cpu: "x64" },
  { name: "linux-arm64", os: "linux", cpu: "arm64", libc: "glibc" },
  { name: "linux-arm64-musl", os: "linux", cpu: "arm64", libc: "musl" },
  { name: "linux-x64", os: "linux", cpu: "x64", libc: "glibc" },
  { name: "linux-x64-musl", os: "linux", cpu: "x64", libc: "musl" },
  { name: "win32-arm64", os: "win32", cpu: "arm64" },
  { name: "win32-x64", os: "win32", cpu: "x64" },
];

export const SCOPE = "@clerk";
export const PKG_PREFIX = "cli";
