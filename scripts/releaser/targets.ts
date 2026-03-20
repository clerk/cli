export interface Target {
  name: string;
  bunTarget: string;
  os: string;
  cpu: string;
  libc?: string;
  ext: string;
  /** Regex to verify the compiled binary format via `file` output. */
  verifyPattern: RegExp;
}

// Target names use Node.js ${process.platform}-${process.arch} convention so the wrapper
// shim (packages/cli/bin/clerk) can derive package names without a lookup table.
// Used by scripts/build.ts and scripts/releaser/index.ts.
export const targets: Target[] = [
  {
    name: "darwin-arm64",
    bunTarget: "bun-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    ext: "",
    verifyPattern: /Mach-O.*arm64/,
  },
  {
    name: "darwin-x64",
    bunTarget: "bun-darwin-x64",
    os: "darwin",
    cpu: "x64",
    ext: "",
    verifyPattern: /Mach-O.*x86_64/,
  },
  {
    name: "linux-arm64",
    bunTarget: "bun-linux-arm64",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
    ext: "",
    verifyPattern: /ELF.*ARM aarch64/,
  },
  {
    name: "linux-arm64-musl",
    bunTarget: "bun-linux-arm64-musl",
    os: "linux",
    cpu: "arm64",
    libc: "musl",
    ext: "",
    verifyPattern: /ELF.*ARM aarch64/,
  },
  {
    name: "linux-x64",
    bunTarget: "bun-linux-x64",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    ext: "",
    verifyPattern: /ELF.*x86-64/,
  },
  {
    name: "linux-x64-musl",
    bunTarget: "bun-linux-x64-musl",
    os: "linux",
    cpu: "x64",
    libc: "musl",
    ext: "",
    verifyPattern: /ELF.*x86-64/,
  },
  {
    name: "win32-arm64",
    bunTarget: "bun-windows-arm64",
    os: "win32",
    cpu: "arm64",
    ext: ".exe",
    verifyPattern: /PE32\+.*Aarch64/,
  },
  {
    name: "win32-x64",
    bunTarget: "bun-windows-x64",
    os: "win32",
    cpu: "x64",
    ext: ".exe",
    verifyPattern: /PE32\+.*x86-64/,
  },
];

export const SCOPE = "@clerk";
export const PKG_PREFIX = "cli";
